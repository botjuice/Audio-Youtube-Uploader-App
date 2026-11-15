/**
 * Auto-set: steering one recording to a rule's target sound.
 *   types   what a target is, what comes back
 *   steer   the decision for every module, from measurements
 *   eq-fit  fitting the EQ to a wanted change in tone
 *   tamer   the Spring tamer from the ring found
 *   check   measuring a result against the target and what to correct next
 * Pure: no files, no ffmpeg. The loop that processes and re-measures is src/main/audio-autoset.ts.
 */
export type { AudioTarget, SuggestNote } from './types'
export { fitEq } from './eq-fit'
export { ringLeftover, tamerFor } from './tamer'
export { noFeedback, setLoudness, staticOver, steer, steerTone, toneDistance, type Feedback, type Steered } from './steer'
export { refine, report, type ReportRow } from './check'
