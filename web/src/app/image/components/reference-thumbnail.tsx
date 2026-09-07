"use client";

import { useImageSource } from "@/store/image-conversations";

export function ReferenceThumbnail({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const source = useImageSource(src);
  return <img src={source} alt={alt} className={className} />;
}
