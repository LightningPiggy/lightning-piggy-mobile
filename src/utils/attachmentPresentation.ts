/** Stable short labels; callers translate the friendly words. */
export function attachmentTypeLabel(mime: string, name: string): string {
  const type = mime.toLowerCase().split(';')[0].trim();
  const labels: Record<string, string> = {
    'application/pdf': 'PDF',
    'application/msword': 'Word',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
    'application/vnd.ms-excel': 'Excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
    'application/vnd.ms-powerpoint': 'PowerPoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
    'application/zip': 'ZIP',
    'application/x-zip-compressed': 'ZIP',
  };
  if (Object.hasOwn(labels, type)) return labels[type];
  if (type.startsWith('text/')) return 'Text';
  if (type.startsWith('audio/')) return 'Audio';
  if (type.startsWith('video/')) return 'Video';
  return name.includes('.') ? name.split('.').pop()!.toUpperCase() : '';
}

export function formatAttachmentSize(bytes: number | undefined): string | null {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1000) return String(Math.round(bytes));
  const unit = bytes < 1e6 ? 'KB' : bytes < 1e9 ? 'MB' : 'GB';
  const divisor = unit === 'KB' ? 1e3 : unit === 'MB' ? 1e6 : 1e9;
  return `${Number((bytes / divisor).toFixed(1))} ${unit}`;
}

export function clampAttachmentAspect(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 1;
  return Math.max(0.6, Math.min(1.8, width / height));
}
