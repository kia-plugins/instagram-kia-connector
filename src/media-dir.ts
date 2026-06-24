import path from 'node:path';

/** Instagram media cache dir under the host-provided shared data root. The
 *  connector namespaces under its own id so connectors never collide. Both
 *  live-API media (downloaded before its signed CDN URL expires) and imported
 *  export media are copied here, content-addressed by the sha256 of the bytes. */
export function mediaDir(dataRoot: string): string {
  return path.join(dataRoot, 'instagram', 'media');
}
