"use client";

export async function prepareOfflineDownloads(): Promise<boolean> {
  if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.register("/offline-downloads.js", { scope: "/downloads" });
  const worker = registration.active ?? registration.waiting ?? registration.installing;
  if (!worker) return false;
  if (worker.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => finish(false), 15_000);
      const finish = (success: boolean) => {
        clearTimeout(deadline);
        worker.removeEventListener("statechange", watch);
        if (success) resolve();
        else reject(new Error("Could not start the offline Downloads cache."));
      };
      const watch = () => {
        if (worker.state === "activated") finish(true);
        else if (worker.state === "redundant") finish(false);
      };
      worker.addEventListener("statechange", watch);
      watch();
    });
  }
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel();
    const timeout = setTimeout(() => finish(false), 25_000);
    const finish = (ready: boolean) => {
      clearTimeout(timeout);
      port1.close();
      resolve(ready);
    };
    port1.onmessage = (event) => finish(event.data === true);
    worker.postMessage("prepare-downloads", [port2]);
  });
}
