"use client";

import Link from "next/link";
import { ChevronRight, Home } from "lucide-react";
import type { BreadcrumbItem } from "@/types";

interface BreadcrumbNavProps {
  path: BreadcrumbItem[];
}

export function BreadcrumbNav({ path }: BreadcrumbNavProps) {
  return (
    <nav aria-label="Folder path" className="flex items-center gap-1 text-sm">
      <Link
        href="/drive"
        id="breadcrumb-root"
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Home className="h-3.5 w-3.5" />
        <span>My Drive</span>
      </Link>

      {path
        .filter((item) => item.name.toLowerCase() !== "my drive")
        .map((item, i, filteredArray) => {
          const isLast = i === filteredArray.length - 1;
          return (
            <span key={item.id} className="flex items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
              {isLast ? (
                <span className="rounded-md px-1.5 py-0.5 font-medium text-foreground">
                  {item.name}
                </span>
              ) : (
                <Link
                  href={`/drive/${item.id}`}
                  id={`breadcrumb-${item.id}`}
                  className="rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  {item.name}
                </Link>
              )}
            </span>
          );
        })}
    </nav>
  );
}
