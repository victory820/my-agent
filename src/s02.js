#!/usr/bin/env node

import os from 'node:os'
import path from 'node:path'
import { exec } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'

import { Anthropic } from '@anthropic-ai/sdk'
import dotenv from 'dotenv'

dotenv.config()

const currentDir = process.cwd()

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL
})

const SYSTEM_PROMPT = `You are a coding agent at ${currentDir}. Use bash to solve tasks. Act, don't explain.`

const TOOLS = [
  {
    name: 'bash',
    description: 'Run a shell command.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read file content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'integer' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in file.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_content: { type: 'string' },
        new_content: { type: 'string' }
      },
      required: ['path', 'old_content', 'new_content']
    }
  }
]

function filePathFromInput(input) {
  return input?.path ?? input?.filePath ?? input?.file_path
}

const TOOL_HANDLERS = {
  bash: (input) => runBash(input.command),
  read_file: (input) => {
    const p = filePathFromInput(input)
    if (p == null || String(p).trim() === '') {
      return 'Error: read_file requires a non-empty path.'
    }
    return runRead(p, input?.limit)
  },
  write_file: (input) => {
    const p = filePathFromInput(input)
    if (p == null || String(p).trim() === '') {
      return 'Error: write_file requires a non-empty path.'
    }
    return runWrite(p, input.content)
  },
  edit_file: (input) => {
    const p = filePathFromInput(input)
    if (p == null || String(p).trim() === '') {
      return 'Error: edit_file requires a non-empty path.'
    }
    return runEdit(p, input.old_content ?? input.oldContent, input.new_content ?? input.newContent)
  }
}

const DANGEROUS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']

/**
 * 确保path在currentDir下
 * @param {string} p
 * @returns {string} 绝对路径
 */
function safePath(p) {
  const absolutePath = path.resolve(currentDir, p)
  const relativePath = path.relative(currentDir, absolutePath)
  if (relativePath.startsWith('..') || (path.isAbsolute(relativePath) && !relativePath)) {
    throw new Error(`Error: Path escapes workspace: ${p}.`)
  }
  return absolutePath
}

/**
 * 允许shell命令，会拦截危险命令，处理超时、输出截断
 * @param {string} command
 * @returns {Promise<string>}
 */

function runBash(command) {
  if (DANGEROUS.some((dangerous) => command.includes(dangerous))) {
    return Promise.reject(new Error('Error: This command is dangerous.'))
  }

  return new Promise((resolve, reject) => {
    const child = exec(
      command,
      {
        shell: true,
        cwd: currentDir,
        timeout: 120000,
        maxBuffer: 500000 * 4
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed && error.signal === 'SIGTERM') {
            reject(new Error('Error: Command timed out.'))
          }
        }

        let out = (stdout || '') + (stderr || '')
        out = out.trim()

        if (!out) {
          out = 'No output.'
        }

        if (out.length > 50000) {
          out = out.slice(0, 50000) + '\n... (truncated)'
        }

        resolve(out)
      }
    )
  })
}

/**
 * 读文件
 * @param {string} filePath
 * @param {number | undefined} limit
 * @returns {string}
 */
function runRead(filePath, limit) {
  try {
    const absolutePath = safePath(filePath)
    const content = fs.readFileSync(absolutePath, 'utf8')
    let lines = content.split(/\r?\n/)

    if (limit && limit < lines.length) {
      const more = lines.length - limit
      lines = lines.slice(0, limit)
      lines.push(`... (${more} more lines)`)
    }

    return lines.join('\n').slice(0, 50000)
  } catch (error) {
    return `Error: ${error.message}`
  }
}
/**
 * 写文件
 * @param {string} filePath
 * @param {string} content
 * @returns {string}
 */
function runWrite(filePath, content) {
  try {
    const absolutePath = safePath(filePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content, 'utf8')
    return `Wrote ${content.length} bytes to ${filePath}.`
  } catch (error) {
    return `Error: ${error.message}`
  }
}
/**
 * 编辑文件。将旧文件替换为新文件，只替换一次
 * @param {string} filePath
 * @param {string} oldContent
 * @param {string} newContent
 * @returns {string}
 */
function runEdit(filePath, oldContent, newContent) {
  try {
    const absolutePath = safePath(filePath)
    const content = fs.readFileSync(absolutePath, 'utf8')
    if (!content.includes(oldContent)) {
      return `Error: ${oldContent} not found in ${filePath}.`
    }

    const updatedContent = content.replace(oldContent, newContent)
    fs.writeFileSync(absolutePath, updatedContent, 'utf8')
    return `Edited ${filePath}.`
  } catch (error) {
    return `Error: ${error.message}`
  }
}

// !!!核心：while循环调用工具，直到模型返回停止
async function agentLoop(messages) {
  console.log('messages===========', messages)
  while (true) {
    const response = await client.messages.create({
      model: process.env.MODEL_ID,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
      max_tokens: 8000
    })

    console.log('返回结果===========', response)

    // 必须保留完整 content（含 tool_use），否则下一条 user 的 tool_result 无法对应
    messages.push({
      role: 'assistant',
      content: response.content
    })

    // 检查是否需要停止
    // if (response.content[0].type === 'tool_use_end') {
    //   return response.content[0].output.text
    // }
    // 如果不需要工具，直接完成
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 执行工具，收集结果
    const results = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const handler = TOOL_HANDLERS[block.name]
        let output
        if (handler) {
          output = await handler(block.input)
        } else {
          output = `Error: Unknown tool: ${block.name}.`
        }

        console.log(`> ${block.name}: ${String(output).slice(0, 200)}`)

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output
        })
      }
    }

    messages.push({
      role: 'user',
      content: results
    })
  }
}

// 命令行交互
async function main() {
  const history = []
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  rl.prompt()

  rl.on('line', async (input) => {
    const query = input
    const trimmed = query.trim().toLowerCase()
    // 退出
    if (trimmed === 'q' || trimmed === 'exit' || trimmed === '') {
      rl.close()
      return
    }

    history.push({
      role: 'user',
      content: query
    })

    try {
      await agentLoop(history)
      console.log('history===========', history)
      const responseContent = history[history.length - 1].content

      if (Array.isArray(responseContent)) {
        for (const block of responseContent) {
          if (block.type === 'text' && typeof block.text === 'string') {
            console.log(`------:${block.text}`)
          }
        }
      }
      console.log()
    } catch (error) {
      console.error('Error:', error)
      console.log()
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('Bye!')
    process.exit(0)
  })
}

main()

// {
//   role: 'user',
//   content: 'list package.json file in this directory not in node_modules'
// },
// { role: 'assistant', content: [ [Object], [Object] ] },
// { role: 'user', content: [ [Object] ] },
// { role: 'assistant', content: [ [Object] ] }
