import type { BreadcrumbItem } from "@/types";

export function breadcrumbsToRelativePath(breadcrumbs: BreadcrumbItem[]): string {
  return breadcrumbs
    .map((item) => item.name)
    .filter((name) => name.toLowerCase() !== "my drive")
    .join("/");
}
