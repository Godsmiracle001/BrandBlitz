import Image from "next/image";
import { notFound } from "next/navigation";

export const revalidate = 60;
export const dynamicParams = true;

const TOP_BRAND_PROFILE_COUNT = 50;

type PublicBrand = {
  id: string;
  name: string;
  logo_url: string | null;
  primary_color: string | null;
  secondary_color: string | null;
  tagline: string | null;
  brand_story: string | null;
  usp: string | null;
  product_image_urls: string[];
};

function apiBaseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api";
}

async function fetchPublicBrand(id: string): Promise<PublicBrand | null> {
  const response = await fetch(`${apiBaseUrl()}/brands/public/${id}`, {
    next: { revalidate },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Unable to load brand profile");
  return (await response.json()).brand as PublicBrand;
}

/** Pre-render the newest active brand profiles; all other IDs use ISR on demand. */
export async function generateStaticParams(): Promise<Array<{ id: string }>> {
  try {
    const response = await fetch(
      `${apiBaseUrl()}/brands/public?limit=${TOP_BRAND_PROFILE_COUNT}`,
      { next: { revalidate } },
    );
    if (!response.ok) return [];
    const data = await response.json() as { brands: Array<{ id: string }> };
    return data.brands.map(({ id }) => ({ id }));
  } catch {
    // The API may not be available during a standalone web build. Profiles
    // still render dynamically on their first request because dynamicParams is true.
    return [];
  }
}

export default async function BrandProfilePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const brand = await fetchPublicBrand(id);
  if (!brand) notFound();

  return (
    <article className="mx-auto max-w-4xl px-6 py-12">
      <header className="flex flex-col gap-6 sm:flex-row sm:items-center">
        {brand.logo_url ? (
          <Image
            src={brand.logo_url}
            alt={`${brand.name} logo`}
            width={160}
            height={160}
            sizes="160px"
            className="h-32 w-32 rounded-2xl object-contain"
          />
        ) : (
          <div
            aria-hidden="true"
            className="h-32 w-32 rounded-2xl"
            style={{ backgroundColor: brand.primary_color ?? "#6366f1" }}
          />
        )}
        <div>
          <h1 className="text-4xl font-bold">{brand.name}</h1>
          {brand.tagline ? (
            <p className="mt-2 text-lg text-[var(--muted-foreground)]">{brand.tagline}</p>
          ) : null}
        </div>
      </header>

      {brand.brand_story ? (
        <section className="mt-10">
          <h2 className="text-xl font-semibold">Our story</h2>
          <p className="mt-3 whitespace-pre-line text-[var(--muted-foreground)]">{brand.brand_story}</p>
        </section>
      ) : null}

      {brand.usp ? (
        <section className="mt-8 rounded-2xl bg-[var(--muted)] p-6">
          <h2 className="text-xl font-semibold">What makes us different</h2>
          <p className="mt-2 text-[var(--muted-foreground)]">{brand.usp}</p>
        </section>
      ) : null}

      {brand.product_image_urls.length > 0 ? (
        <section className="mt-10">
          <h2 className="text-xl font-semibold">Products</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {brand.product_image_urls.map((url, index) => (
              <Image
                key={url}
                src={url}
                alt={`${brand.name} product ${index + 1}`}
                width={800}
                height={600}
                className="h-auto w-full rounded-xl object-cover"
              />
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}
