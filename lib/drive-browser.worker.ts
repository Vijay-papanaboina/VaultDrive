type SortBy = "created" | "modified" | "size" | "name";
type SortOrder = "asc" | "desc";

interface IndexedMetaRecord {
  id: string;
  originalNameNormalized: string;
  detailsNameNormalized: string;
  createdAtMs: number;
  modifiedAtMs: number;
  originalSizeBytes: number;
  metaName: string;
}

type WorkerMessage =
  | {
      type: "set-files";
      records: IndexedMetaRecord[];
    }
  | {
      type: "compute";
      requestId: number;
      searchQuery: string;
      sortBy: SortBy;
      sortOrder: SortOrder;
    };

const metaNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

let records: IndexedMetaRecord[] = [];

function normalize(str: string) {
  return str.toLowerCase().replace(/\s+/g, "");
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  if (message.type === "set-files") {
    records = message.records;
    return;
  }

  const queryNormalized = normalize(message.searchQuery);
  const filtered = queryNormalized
    ? records.filter((record) => {
        return (
          record.originalNameNormalized.includes(queryNormalized) ||
          record.detailsNameNormalized.includes(queryNormalized)
        );
      })
    : records.slice();

  filtered.sort((a, b) => {
    let comparison = 0;

    if (message.sortBy === "created") {
      comparison = a.createdAtMs - b.createdAtMs;
    } else if (message.sortBy === "modified") {
      comparison = a.modifiedAtMs - b.modifiedAtMs;
    } else if (message.sortBy === "size") {
      comparison = a.originalSizeBytes - b.originalSizeBytes;
    } else {
      comparison = metaNameCollator.compare(a.metaName, b.metaName);
    }

    return message.sortOrder === "asc" ? comparison : -comparison;
  });

  self.postMessage({
    requestId: message.requestId,
    orderedIds: filtered.map((record) => record.id),
  });
};
