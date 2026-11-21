"use client";
// A page's record of its blur-save boxes' landed saves (src/lib/saved-mark.ts), for SavedMark.
import { useCallback, useState } from "react";
import { recordSaved, savedShows, type SavedRecord } from "./saved-mark";

export type SavedMarks = {
  /** Call on a save's success path only, with the text the box sent. */
  mark: (key: string, value: string, opts?: { decimal?: boolean }) => void;
  /** Whether box `key`, now showing `shownText`, reads Saved. */
  shows: (key: string, shownText: string) => boolean;
};

export function useSavedMarks(): SavedMarks {
  const [last, setLast] = useState<SavedRecord>({});
  const mark = useCallback((key: string, value: string, opts?: { decimal?: boolean }) => {
    setLast((cur) => recordSaved(cur, key, value, opts?.decimal ?? false));
  }, []);
  return { mark, shows: (key, shownText) => savedShows(last, key, shownText) };
}
