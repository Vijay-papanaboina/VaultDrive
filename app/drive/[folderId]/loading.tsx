import { Skeleton } from "@/components/ui/skeleton";

function CardSkeleton() {
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-white/8 bg-white/3">
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex gap-2">
          <Skeleton className="h-5 w-16 rounded-full" />
          <Skeleton className="h-5 w-12 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function FolderSkeleton() {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-white/8 bg-white/3 p-4">
      <Skeleton className="h-10 w-10 rounded-lg" />
      <Skeleton className="h-3 w-16" />
    </div>
  );
}

export default function FolderLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb skeleton */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-3 w-3 rounded-full" />
        <Skeleton className="h-4 w-24" />
      </div>

      {/* Subfolders skeleton */}
      <section>
        <Skeleton className="mb-3 h-4 w-24" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <FolderSkeleton key={i} />
          ))}
        </div>
      </section>

      {/* Meta files skeleton */}
      <section>
        <Skeleton className="mb-4 h-4 w-32" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      </section>
    </div>
  );
}
