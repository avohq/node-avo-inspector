import { deepEquals } from "./utils";

// A registration, in time order, so expired ones are popped from the front.
interface Registration {
  time: number;
  key: string;
}

export class AvoDeduplicator {
  // Every registration, oldest first; `head` is the first one not yet expired. Cleanup pops
  // from the front, so its cost is amortised O(1) per call.
  avoFunctionsEvents: Array<Registration> = [];
  manualEvents: Array<Registration> = [];
  private avoFunctionsHead = 0;
  private manualHead = 0;
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
      this.avoFunctionsEvents.push({ time: Date.now(), key });
      this.avoFunctionsEventsParams[key] = params;
    } else {
      this.manualEvents.push({ time: Date.now(), key });
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
    this.avoFunctionsHead = this.expire(
      this.avoFunctionsEvents, this.avoFunctionsHead, this.avoFunctionsEventsParams, now
    );
    this.manualHead = this.expire(this.manualEvents, this.manualHead, this.manualEventsParams, now);
    if (this.avoFunctionsHead > 1024 && this.avoFunctionsHead * 2 > this.avoFunctionsEvents.length) {
      this.avoFunctionsEvents = this.avoFunctionsEvents.slice(this.avoFunctionsHead);
      this.avoFunctionsHead = 0;
    }
    if (this.manualHead > 1024 && this.manualHead * 2 > this.manualEvents.length) {
      this.manualEvents = this.manualEvents.slice(this.manualHead);
      this.manualHead = 0;
    }
  }

  // Deletes the params of every registration older than msToConsiderOld; returns the new head.
  private expire(
    registrations: Array<Registration>,
    head: number,
    paramsByKey: { [key: string]: { [propName: string]: any } },
    now: number
  ): number {
    while (head < registrations.length && now - registrations[head].time > this.msToConsiderOld) {
      delete paramsByKey[registrations[head].key];
      head++;
    }
    return head;
  }

  // used in tests
  private _clearEvents() {
    this.avoFunctionsEvents = [];
    this.manualEvents = [];
    this.avoFunctionsHead = 0;
    this.manualHead = 0;

    this.avoFunctionsEventsParams = {};
    this.manualEventsParams = {};
  }
}
