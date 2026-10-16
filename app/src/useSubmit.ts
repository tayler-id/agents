import { useState, type SyntheticEvent } from 'react'
import { messageOf } from './data.ts'

// A small form that reports its own errors.
export function useSubmit(action: () => Promise<unknown>, reset: () => void) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await action()
      reset()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }
  return { submit, error, busy }
}
