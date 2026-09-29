import { AvoInspector } from "./AvoInspector";

export class AvoStreamId {
  private _streamId: string;

  // Accepts whatever a JavaScript caller passes. Numbers, bigints and booleans (a numeric
  // user id, say) are sent as their string form; any other non-string is ignored.
  constructor(streamId?: unknown) {
    this._streamId = AvoStreamId.normalize(streamId);
    if (this._streamId.includes(":")) {
      console.warn(
        "[Avo Inspector] Warning: streamId contains ':' which is not supported"
      );
    }
  }

  private static normalize(streamId: unknown): string {
    if (streamId === undefined || streamId === null) {
      return "";
    }
    if (typeof streamId === "string") {
      return streamId;
    }
    if (typeof streamId === "number" || typeof streamId === "bigint" || typeof streamId === "boolean") {
      return String(streamId);
    }
    if (AvoInspector.shouldLog) {
      console.warn(
        "[Avo Inspector] Warning: streamId must be a string; ignoring a value of type " + typeof streamId
      );
    }
    return "";
  }

  get streamId(): string {
    return this._streamId;
  }
}
