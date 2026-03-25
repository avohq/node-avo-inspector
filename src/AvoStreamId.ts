export class AvoStreamId {
  private _streamId: string;

  constructor(streamId?: string) {
    this._streamId = streamId ?? "";
    if (this._streamId.includes(":")) {
      console.warn(
        "[Avo Inspector] Warning: streamId contains ':' which is not supported"
      );
    }
  }

  get streamId(): string {
    return this._streamId;
  }
}
