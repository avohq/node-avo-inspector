import { deepEquals } from "./utils";

export class AvoDeduplicator {
  avoFunctionsEvents: { [time: number]: string } = {};
  manualEvents: { [time: number]: string } = {};
  private msToConsiderOld = 500;

  // Keyed by streamId\0eventName to prevent cross-stream suppression on server
  avoFunctionsEventsParams: {
    [key: string]: { [propName: string]: any };
  } = {};
  manualEventsParams: { [key: string]: { [propName: string]: any } } = {};

  private static dedupKey(eventName: string, streamId: string): string {
    return streamId + "\0" + eventName;
  }

  shouldRegisterEvent(
    eventName: string,
    params: { [propName: string]: any },
    fromAvoFunction: boolean,
    streamId: string = ""
  ): boolean {
    this.clearOldEvents();

    const key = AvoDeduplicator.dedupKey(eventName, streamId);

    if (fromAvoFunction) {
      this.avoFunctionsEvents[Date.now()] = key;
      this.avoFunctionsEventsParams[key] = params;
    } else {
      this.manualEvents[Date.now()] = key;
      this.manualEventsParams[key] = params;
    }

    let checkInAvoFunctions = !fromAvoFunction;

    return !this.hasSameEventAs(key, params, checkInAvoFunctions);
  }

  private hasSameEventAs(
    key: string,
    params: { [propName: string]: any },
    checkInAvoFunctions: boolean
  ): boolean {
    let result = false;

    if (checkInAvoFunctions) {
      if (
        this.lookForEventIn(key, params, this.avoFunctionsEventsParams)
      ) {
        result = true;
      }
    } else {
      if (this.lookForEventIn(key, params, this.manualEventsParams)) {
        result = true;
      }
    }

    if (result) {
      delete this.avoFunctionsEventsParams[key];
      delete this.manualEventsParams[key];
    }

    return result;
  }

  private lookForEventIn(
    key: string,
    params: { [propName: string]: any },
    eventsStorage: { [key: string]: { [propName: string]: any } }
  ): boolean {
    if (eventsStorage.hasOwnProperty(key)) {
      const otherParams = eventsStorage[key];
      if (otherParams && deepEquals(params, otherParams)) {
        return true;
      }
    }
    return false;
  }

  hasSeenEventParams(
    params: { [propName: string]: any },
    checkInAvoFunctions: boolean
  ) {
    let result = false;

    if (checkInAvoFunctions) {
      if (this.lookForEventParamsIn(params, this.avoFunctionsEventsParams)) {
        result = true;
      }
    } else {
      if (this.lookForEventParamsIn(params, this.manualEventsParams)) {
        result = true;
      }
    }

    return result;
  }

  private lookForEventParamsIn(
    params: { [propName: string]: any },
    eventsStorage: { [eventName: string]: { [propName: string]: any } }
  ): boolean {
    for (const otherEventName in eventsStorage) {
      if (eventsStorage.hasOwnProperty(otherEventName)) {
        const otherParams = eventsStorage[otherEventName];
        if (otherParams && deepEquals(params, otherParams)) {
          return true;
        }
      }
    }
    return false;
  }

  private clearOldEvents() {
    const now = Date.now();

    for (const time in this.avoFunctionsEvents) {
      if (this.avoFunctionsEvents.hasOwnProperty(time)) {
        const timestamp = Number(time) || 0;
        if (now - timestamp > this.msToConsiderOld) {
          const key = this.avoFunctionsEvents[time];
          delete this.avoFunctionsEvents[time];
          delete this.avoFunctionsEventsParams[key];
        }
      }
    }

    for (const time in this.manualEvents) {
      if (this.manualEvents.hasOwnProperty(time)) {
        const timestamp = Number(time) || 0;
        if (now - timestamp > this.msToConsiderOld) {
          const key = this.manualEvents[time];
          delete this.manualEvents[time];
          delete this.manualEventsParams[key];
        }
      }
    }
  }

  // used in tests
  private _clearEvents() {
    this.avoFunctionsEvents = {};
    this.manualEvents = {};

    this.avoFunctionsEventsParams = {};
    this.manualEventsParams = {};
  }
}
