import { TidalApi } from "@luna/lib";

/** Tidal write endpoints reject BCP 47 locale (`en-us`); normalize to POSIX form (`en_US`). */
export function tidalQueryArgs(): string {
	return TidalApi.queryArgs().replace(
		/locale=([a-z]+)-([a-z]+)/i,
		(_, lang: string, region: string) => `locale=${lang.toLowerCase()}_${region.toUpperCase()}`,
	);
}

/** Auth headers without `x-tidal-token`. Tidal's write endpoints validate it against the JWT `cid` and 404 on mismatch. */
export async function tidalAuthHeaders(): Promise<{ Authorization: string }> {
	const headers = await TidalApi.getAuthHeaders();
	return { Authorization: headers.Authorization };
}
