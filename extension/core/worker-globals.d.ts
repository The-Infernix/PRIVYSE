// Ambient declarations for service-worker APIs used by the sanitizer
// (OffscreenCanvas, createImageBitmap). DOM lib already ships these in modern
// TS lib.dom, but WXT's lib set may not include ImageBitmap types everywhere.

declare function createImageBitmap(
  image: Blob | ImageData | HTMLImageElement | HTMLVideoElement | HTMLCanvasElement,
  options?: ImageBitmapOptions,
): Promise<ImageBitmap>;

interface OffscreenCanvasRenderingContext2D
  extends CanvasRenderingContext2D {}

interface OffscreenCanvas {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): OffscreenCanvasRenderingContext2D | null;
  convertToBlob(options?: {
    type?: string;
    quality?: number;
  }): Promise<Blob>;
  close(): void;
}

declare const OffscreenCanvas: {
  prototype: OffscreenCanvas;
  new (width: number, height: number): OffscreenCanvas;
};
