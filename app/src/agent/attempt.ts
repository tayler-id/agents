import { useState } from 'react'
import { messageOf } from '../data.ts'

// Runs a call from a tap and keeps what the person needs to see of it: whether it is under
// way, and why it failed until they dismiss it or try again. A failed call answers null.
export function useAttempt() {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')
  const attempt = async <T>(call: () => Promise<T>): Promise<T | null> => {
    setBusy(true)
    setProblem('')
    try {
      return await call()
    } catch (error) {
      setProblem(messageOf(error))
      return null
    } finally {
      setBusy(false)
    }
  }
  return { busy, problem, attempt, dismiss: () => { setProblem('') } }
}
