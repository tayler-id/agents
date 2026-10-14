// Compile-time proofs that the coding framework's types reject impossible
// states. The typecheck compiles this file, and nothing runs it. Each line
// says whether one type fits another, and states the answer. If a type is
// loosened until an impossible state fits, that line stops compiling. It uses
// no ts-expect-error, which the gates forbid.

import type { PassingVerdict, Readiness, ReadyProof } from '../shared/framework.ts'

// Whether T fits U. An impossible intersection is never, which fits anything,
// so the impossible states below replace a field with Omit instead.
type Fits<T, U> = [T] extends [U] ? true : false
type Swap<T, K extends keyof T, V> = Omit<T, K> & Record<K, V>

// What may happen fits.
export const readyWithProof: Fits<{ kind: 'ready'; proof: ReadyProof }, Readiness> = true
export const blockedWithReasons: Fits<{ kind: 'blocked'; reasons: readonly ['a gate failed'] }, Readiness> = true
export const typeCheckOnlyPasses: Fits<'type-check-only', PassingVerdict> = true

// A verifier that could not judge, or that failed the change, gave no passing verdict.
export const blockedIsNotPassing: Fits<'verifier-blocked', PassingVerdict> = false
export const failedIsNotPassing: Fits<'verifier-failed', PassingVerdict> = false

// Ready is nothing without its proof, and blocked names at least one reason.
export const readyNeedsProof: Fits<{ kind: 'ready' }, Readiness> = false
export const blockedNeedsAReason: Fits<{ kind: 'blocked'; reasons: readonly [] }, Readiness> = false

// No part of the proof can hold a state that blocks a merge.
export const conflictIsNoProof: Fits<{ kind: 'ready'; proof: Swap<ReadyProof, 'mergeTree', 'conflict'> }, Readiness> = false
export const failingGatesAreNoProof: Fits<Swap<ReadyProof, 'gates', 'failing'>, ReadyProof> = false
export const blockedVerdictIsNoProof: Fits<Swap<ReadyProof, 'verdict', { kind: 'met'; level: 'verifier-blocked'; model: string }>, ReadyProof> = false

// A verdict below the floor is proof only with the name of whoever accepted it.
export const acceptedBlockedIsProof: Fits<Swap<ReadyProof, 'verdict', { kind: 'accepted'; verdict: 'verifier-blocked'; model: string; acceptedBy: string }>, ReadyProof> = true
export const acceptanceNeedsAName: Fits<Swap<ReadyProof, 'verdict', { kind: 'accepted'; verdict: 'verifier-blocked'; model: string }>, ReadyProof> = false
export const unreviewedIsNoProof: Fits<Swap<ReadyProof, 'reviews', 'blocking'>, ReadyProof> = false
export const noOwnerIsNoProof: Fits<Omit<ReadyProof, 'owner'>, ReadyProof> = false
