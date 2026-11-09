// Shared-memory layout between the UI thread and the audio thread.
export const STATUS_LEN = 24;   // Float64 slots, see ST below
export const METER_STRIDE = 8;  // Float32 per slot: peakL, peakR, rmsL, rmsR, clip, -, -, -
export const TELE_STRIDE = 4;   // Float32 per slot: wtPosA, wtPosB, cutoffHz, activeVoices
export const MAX_SLOTS = 128;

// Status slots (Float64Array).
export const ST = {
  POS: 0, PLAY: 1, COUNT_IN: 2, CPU: 3, FRAME: 4, TIME: 5, NAN: 6, TEMPO: 7, SEQ: 8,
  IN_PK_L: 9, IN_PK_R: 10, IN_CH: 11, IN_ON: 12, REC_ACTIVE: 13,
  IN_BLOCK_FRAME: 16, IN_BLOCK_POS: 17, // engine frame and ring position at the start of the last captured block
};
// Input ring control (Int32Array, shared): [0] = total samples written (wrapping uint32).
export const INPUT_RING_SECONDS = 6;
