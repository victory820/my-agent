import dotenv from 'dotenv'
import { Anthropic } from '@anthropic-ai/sdk'

dotenv.config()

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL
})

const currentDir = process.cwd()

const SYSTEM_PROMPT = `You are a coding agent at ${currentDir}. Use bash to solve tasks. Act, don't explain.`

async function agentLoop(messages) {
  while (true) {
    const response = await client.messages.create({
      model: process.env.MODEL_ID,
      system: SYSTEM_PROMPT,
      messages,
      max_tokens: 8000
    })

    messages.push({
      role: 'assistant',
      content: response.content
    })

    // 结束循环
    if (response.stop_reason != 'tool_use') {
      return
    }
  }
}

function main() {
  const history = []

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  rl.prompt()

  rl.on('line', async (input) => {
    const query = input

    const trimmed = query.trim().toLowerCase()

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
    } catch (error) {
      console.error('Error:', error)
    }
  })
}
