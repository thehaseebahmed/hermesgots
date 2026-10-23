export class FakeRecorder {
  static isTypeSupported() {
    return true
  }
  state = "inactive"
  mimeType = "audio/webm"
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null
  private listeners: (() => void)[] = []
  private timer?: ReturnType<typeof setInterval>
  addEventListener(name: string, listener: () => void) {
    if (name === "stop") this.listeners.push(listener)
  }
  start(ms: number) {
    this.state = "recording"
    this.timer = setInterval(
      () => this.ondataavailable?.({ data: new Blob(["slice"], { type: "audio/webm" }) }),
      Math.max(ms, 40),
    )
  }
  stop() {
    if (this.state === "inactive") return
    clearInterval(this.timer)
    this.state = "inactive"
    for (const listener of this.listeners) listener()
  }
}

export function fakeMic() {
  const track = () => ({ stop() {}, addEventListener() {}, kind: "audio" })
  return async () => ({
    getTracks: () => [track()],
    getAudioTracks: () => [track()],
  })
}

export function installFakeMedia() {
  window.MediaRecorder = FakeRecorder as unknown as typeof MediaRecorder
  Object.assign(globalThis, { MediaRecorder: FakeRecorder })
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: fakeMic() },
    configurable: true,
  })
}
