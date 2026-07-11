import { Skeleton } from "@/components/ui/skeleton";

function FolderSkeleton() {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-white/8 bg-white/3 p-4">
      <Skeleton className="h-10 w-10 rounded-lg" />
      <Skeleton className="h-3 w-16" />
    </div>
  );
}

export default function DriveLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-9 rounded-xl" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3.5 w-48" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {Array.from({ length: 12 }).map((_, i) => (
          <FolderSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
