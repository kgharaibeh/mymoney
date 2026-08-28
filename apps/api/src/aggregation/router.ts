/**
 * AggregationRouter — picks a bank-aggregation provider by country, and looks
 * one up by name. This is what makes "any bank account, globally" a routing
 * decision: register a provider per region, and a broad provider (Salt Edge,
 * whose `supportedCountries()` returns ["*"]) as the fallback.
 */

import type { AggregationProvider, AggregatorProviderName } from "@mymoney/domain";

export class AggregationRouter {
  private readonly byName = new Map<AggregatorProviderName, AggregationProvider>();

  constructor(private readonly providers: AggregationProvider[]) {
    for (const p of providers) this.byName.set(p.name, p);
  }

  /** Providers registered, in priority order (specific before wildcard). */
  list(): AggregationProvider[] {
    return this.providers;
  }

  /** The provider that serves a country: an exact match wins over a "*" fallback. */
  forCountry(country: string): AggregationProvider {
    const c = country.toUpperCase();
    const exact = this.providers.find((p) =>
      p.supportedCountries().some((x) => x.toUpperCase() === c),
    );
    if (exact) return exact;
    const wildcard = this.providers.find((p) => p.supportedCountries().includes("*"));
    if (wildcard) return wildcard;
    throw new Error(`No aggregation provider available for country "${country}".`);
  }

  getByName(name: AggregatorProviderName): AggregationProvider {
    const provider = this.byName.get(name);
    if (!provider) throw new Error(`No aggregation provider registered named "${name}".`);
    return provider;
  }
}
