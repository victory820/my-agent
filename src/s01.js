#!/usr/bin/env node

import os from 'node:os'
import path from 'node:path'
import { exec } from 'node:child_process'
import readline from 'node:readline'

// import { runBash } from '../utils/runBash.js'
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
  }
]

const DANGEROUS = ['rm -rf /', 'sudo', 'shutdown', 'reboot', '> /dev/']

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
        cwd: process.cwd(),
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

// 核心：while循环调用工具，直到模型返回停止
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

    // 添加助理角色
    messages.push({
      role: 'assistant',
      content: response.content[0].text
    })

    // 检查是否需要停止
    if (response.content[0].type === 'tool_use_end') {
      return response.content[0].output.text
    }
    // 如果不需要工具，直接完成
    if (response.stop_reason !== 'tool_use') {
      return
    }

    // 执行工具，收集结果
    const results = []
    for (const block of response.content) {
      if (block.type === 'tool_use') {
        const command = block.input.command
        // type: 'tool_use',
        // id: 'call_00_5Y8iIRfppKpuvWfAIVDINNLE',
        // name: 'bash',
        // input: { command: 'ls -l' }
        console.log('执行命令===========', command)
        const output = await runBash(command)

        console.log('执行命令后的输入：：：：', output)
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: output
        })
      }
    }

    console.log('results===========', results)
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
    }
    rl.prompt()
  })

  rl.on('close', () => {
    console.log('Bye!')
    process.exit(0)
  })
}

main()
