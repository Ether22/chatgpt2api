"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { useImageSource } from "@/store/image-conversations";

type ImageThumbnailProps = {
  src: string;
  thumbnailSrc?: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
};

export function getImageThumbnailUrl(src: string) {
  const marker = "/images/";
  const index = src.indexOf(marker);
  if (index < 0) return src;
  return `${src.slice(0, index)}/image-thumbnails/${src.slice(index + marker.length)}`;
}

export function ImageThumbnail({ src, thumbnailSrc, alt = "", className, imageClassName }: ImageThumbnailProps) {
  const initialSrc = useMemo(() => thumbnailSrc || getImageThumbnailUrl(src), [src, thumbnailSrc]);
  const [currentSrc, setCurrentSrc] = useState(initialSrc);
  const [unavailable, setUnavailable] = useState(false);
  const onError = useCallback(() => {
    if (currentSrc !== src) setCurrentSrc(src);
    else setUnavailable(true);
  }, [currentSrc, src]);
  const imageSource = useImageSource(currentSrc, 0, onError);

  useEffect(() => {
    setCurrentSrc(initialSrc);
    setUnavailable(false);
  }, [initialSrc]);

  return (
    <span className={cn("block overflow-hidden bg-stone-100", className)}>
      {unavailable ? <span role="img" aria-label="图片不可用" className="flex h-full items-center justify-center text-[10px] text-stone-400">图片不可用</span> : <img
        src={imageSource}
        alt={alt}
        className={cn("h-full w-full object-cover", imageClassName)}
        loading="lazy"
        decoding="async"
        onError={onError}
      />}
    </span>
  );
}
