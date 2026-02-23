export class AvoStreamId {
  private _streamId: string;

  constructor(streamId?: string) {
    this._streamId = streamId ?? "";
  }

  get streamId(): string {
    if (this._streamId.includes(":")) {
      console.warn(
        "[Avo Inspector] Warning: streamId contains ':' which is not supported"
      );
    }
    return this._streamId;
  }
}
