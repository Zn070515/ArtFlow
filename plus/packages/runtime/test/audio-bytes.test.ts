import { describe, expect, it } from "vitest";

import { audioBytesMatchSlot, slotAcceptsAudio } from "../src/audio-bytes.js";

const mp3Frame = Uint8Array.from([0xff, 0xfb, 0x90, 0x00]);

describe("audio byte checks", () => {
  it("accepts an MP3 frame or ID3 header and rejects a short non-audio .mp3", () => {
    expect(audioBytesMatchSlot([".mp3"], mp3Frame)).toBe(true);
    expect(audioBytesMatchSlot([".mp3"], new TextEncoder().encode("ID3-e2e-demo"))).toBe(true);
    const junk = new TextEncoder().encode("not-audio-content");
    expect(junk.byteLength).toBe(17);
    expect(audioBytesMatchSlot([".mp3"], junk)).toBe(false);
    expect(audioBytesMatchSlot([".mp3"], Uint8Array.from([1, 1, 1, 1, 1]))).toBe(false);
  });

  it("matches only the containers the slot accepts", () => {
    const wav = new TextEncoder().encode("RIFF....WAVEfmt ");
    expect(audioBytesMatchSlot([".mp3"], wav)).toBe(false);
    expect(audioBytesMatchSlot([".wav"], wav)).toBe(true);
    expect(audioBytesMatchSlot([".mp3", ".wav"], wav)).toBe(true);
    expect(slotAcceptsAudio({ purpose: "accompaniment", accepts: [".mp3"] })).toBe(true);
    expect(slotAcceptsAudio({ purpose: "audio", accepts: [".bin"] })).toBe(true);
    expect(slotAcceptsAudio({ purpose: "video", accepts: [".mp4", ".mov"] })).toBe(false);
  });
});
