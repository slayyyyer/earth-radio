/**
 * Turn a day of events into a deterministic performance score.
 *
 * Most quakes keep a voice of their own. When three or four quakes fall inside
 * a short UTC window, they become one chord-like phrase instead of competing
 * for the 16-voice ceiling. Every event still appears in the map and log; the
 * arrangement only changes how the densest moments are voiced.
 */

export const CLUSTER_WINDOW_MS = 5 * 60 * 1000;
export const MIN_CLUSTER_SIZE = 3;
export const MAX_CLUSTER_SIZE = 4;

function chronological(a, b) {
  return a.offset - b.offset || String(a.id).localeCompare(String(b.id));
}

/**
 * @param {object[]} events normalized events with `offset` and `mag`
 * @returns {{startOffset:number, members:object[], lead:object, isCluster:boolean}[]}
 */
export function buildPhrases(events = [], options = {}) {
  const clusterWindowMs = Number.isFinite(options.clusterWindowMs)
    ? Math.max(0, options.clusterWindowMs)
    : CLUSTER_WINDOW_MS;
  const minClusterSize = Number.isInteger(options.minClusterSize)
    ? Math.max(2, options.minClusterSize)
    : MIN_CLUSTER_SIZE;
  const maxClusterSize = Number.isInteger(options.maxClusterSize)
    ? Math.max(minClusterSize, options.maxClusterSize)
    : MAX_CLUSTER_SIZE;

  const sorted = events
    .filter((event) => event && Number.isFinite(event.offset))
    .sort(chronological);
  const phrases = [];
  let index = 0;

  while (index < sorted.length) {
    const start = sorted[index];
    const group = [start];
    let next = index + 1;

    while (
      next < sorted.length &&
      group.length < maxClusterSize &&
      sorted[next].offset - start.offset <= clusterWindowMs
    ) {
      group.push(sorted[next]);
      next += 1;
    }

    if (group.length >= minClusterSize) {
      const lead = group.reduce((strongest, event) =>
        event.mag > strongest.mag ? event : strongest,
      );
      phrases.push({
        startOffset: start.offset,
        members: group,
        lead,
        isCluster: true,
      });
      index = next;
    } else {
      // Do not drag a quiet neighbour into a phrase. Re-evaluate from the next
      // event so a later run of dense quakes can still form a chord.
      phrases.push({
        startOffset: start.offset,
        members: [start],
        lead: start,
        isCluster: false,
      });
      index += 1;
    }
  }

  return phrases;
}

/** Index of the first phrase at or after a UTC offset. */
export function lowerBoundPhrase(phrases, offsetMs) {
  let low = 0;
  let high = phrases.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (phrases[middle].startOffset < offsetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}
