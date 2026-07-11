"use client";

import Link from "next/link";
import { Folder, FolderOpen } from "lucide-react";
import type { DriveFolder } from "@/types";
import { cn } from "@/lib/utils";

interface FolderListProps {
  folders: DriveFolder[];
  activeFolderId?: string;
}

export function FolderList({ folders, activeFolderId }: FolderListProps) {
  if (folders.length === 0) {
    return (
      <p className="px-2 py-4 text-center text-sm text-muted-foreground">
        No folders found
      </p>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {folders.map((folder) => {
        const isActive = folder.id === activeFolderId;
        return (
          <Link
            key={folder.id}
            href={`/drive/${folder.id}`}
            id={`folder-${folder.id}`}
            className={cn(
              "group flex flex-col items-center gap-2.5 rounded-xl border p-4 text-center transition-all duration-200",
              "hover:border-violet-500/40 hover:bg-violet-500/5",
              isActive
                ? "border-violet-500/50 bg-violet-500/10"
                : "border-white/8 bg-white/3"
            )}
          >
            <div className="relative">
              {isActive ? (
                <FolderOpen className="h-10 w-10 text-violet-400 transition-transform group-hover:scale-105" />
              ) : (
                <Folder className="h-10 w-10 text-muted-foreground transition-transform group-hover:scale-105 group-hover:text-violet-400" />
              )}
            </div>
            <span
              className={cn(
                "line-clamp-2 text-xs font-medium leading-tight",
                isActive ? "text-violet-300" : "text-foreground/80"
              )}
              title={folder.name}
            >
              {folder.name}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
