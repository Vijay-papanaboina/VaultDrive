"use client";

import { useState } from "react";
import Link from "next/link";
import { Folder, FolderOpen, Search } from "lucide-react";
import type { DriveFolder } from "@/types";
import { cn } from "@/lib/utils";

interface FolderListProps {
  folders: DriveFolder[];
  activeFolderId?: string;
}

export function FolderList({ folders, activeFolderId }: FolderListProps) {
  const [contextMenu, setContextMenu] = useState<{
    folder: DriveFolder;
    x: number;
    y: number;
  } | null>(null);

  if (folders.length === 0) {
    return (
      <p className="px-2 py-4 text-center text-sm text-muted-foreground">
        No folders found
      </p>
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {folders.map((folder) => {
          const isActive = folder.id === activeFolderId;
          return (
            <Link
              key={folder.id}
              href={`/drive/${folder.id}`}
              id={`folder-${folder.id}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu({
                  folder,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
              className={cn(
                "group flex flex-col items-center gap-2.5 rounded-xl border p-4 text-center transition-all duration-200 cursor-pointer select-none",
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

      {contextMenu && (
        <>
          {/* Overlay to catch clicks and close the menu */}
          <div
            className="fixed inset-0 z-40 bg-transparent"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setContextMenu(null);
            }}
          />
          {/* Custom Context Menu */}
          <div
            className="fixed z-50 min-w-48 rounded-xl border border-white/10 bg-[#0f0f13]/95 p-1.5 text-foreground shadow-2xl backdrop-blur-2xl animate-in fade-in-0 zoom-in-95 duration-100 flex flex-col gap-0.5"
            style={{
              top: contextMenu.y,
              left: contextMenu.x,
            }}
          >
            <div className="px-2.5 py-1 text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-wider">
              {contextMenu.folder.name}
            </div>
            <Link
              href={`/drive/${contextMenu.folder.id}`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-white/5 text-foreground/80 hover:text-foreground transition-all cursor-pointer"
              onClick={() => setContextMenu(null)}
            >
              <FolderOpen className="h-3.5 w-3.5 opacity-60" />
              <span>Open Folder</span>
            </Link>
            <Link
              href={`/drive/${contextMenu.folder.id}/search`}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs hover:bg-violet-500/10 text-foreground/80 hover:text-violet-300 transition-all cursor-pointer"
              onClick={() => setContextMenu(null)}
            >
              <Search className="h-3.5 w-3.5 opacity-60 text-violet-400" />
              <span>Open in Search Mode</span>
            </Link>
          </div>
        </>
      )}
    </>
  );
}

