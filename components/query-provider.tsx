"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: Infinity, // Keep cache fresh indefinitely unless explicitly refreshed
            gcTime: 10 * 60 * 1000, // Garbage collect after 10 minutes of inactivity
            refetchOnWindowFocus: false, // Disable automatic focus refetching
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}
