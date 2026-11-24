// @polsia:framework-owned — DO NOT EDIT. Code installed by polsia/template-next@0.3.0.
//
// /manifest.webmanifest — short name, colors and icons come from `brandVisual` in src/lib/brand.ts; set them there.
import type { MetadataRoute } from 'next';
import { brandVisual } from '@/lib/brand';
import { siteDescription, siteName } from '@/lib/site';

type ManifestIcon = NonNullable<MetadataRoute.Manifest['icons']>[number];

const DEFAULT_ICONS: ManifestIcon[] = [{ src: '/icon.svg', type: 'image/svg+xml', sizes: 'any' }];

export default function manifest(): MetadataRoute.Manifest {
  // brand.ts is user-owned, so apps created before `icons` existed never get the field.
  const { icons }: typeof brandVisual & { icons?: readonly ManifestIcon[] } = brandVisual;
  const { shortName }: Readonly<Record<string, unknown>> = brandVisual;

  return {
    name: siteName,
    short_name: typeof shortName === 'string' && shortName ? shortName : siteName,
    description: siteDescription,
    start_url: '/',
    display: 'standalone',
    background_color: brandVisual.backgroundColor,
    theme_color: brandVisual.themeColor,
    icons: icons?.length ? [...icons] : DEFAULT_ICONS,
  };
}
