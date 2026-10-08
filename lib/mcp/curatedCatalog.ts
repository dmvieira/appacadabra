/**
 * Curated seed catalog of well-known *remote* MCP servers.
 *
 * Rationale: the public MCP Registry does not list every remote server
 * (e.g. PicPay's official OAuth server is not indexed there), and it only
 * covers publicly-accessible servers. This curated list guarantees a good
 * first-run experience and gives the generation pipeline a stable, known set
 * of providers to reason about.
 *
 * Only remote HTTP/SSE servers belong here — stdio servers cannot run on
 * mobile. Keep entries small and verified.
 */

import type { McpProvider } from './types';

export const CURATED_PROVIDERS: McpProvider[] = [
    {
        slug: 'picpay',
        name: 'PicPay',
        description:
            'Consulte saldo, extrato, faturas de cartão, investimentos e cofrinhos do PicPay via Open Finance (somente leitura por padrão).',
        mcpUrl: 'https://mcp.svc.picpay.com/v2/mcp',
        transport: 'streamable-http',
        authStrategy: 'oauth',
        websiteUrl: 'https://picpay.com',
        source: 'curated',
        scopes: [
            'openid',
            'offline_access',
            'wallet.read',
            'piggy_bank.read',
            'pix.read',
        ],
    },
    {
        slug: 'context7',
        name: 'Context7',
        description: 'Busca documentação atualizada de bibliotecas e frameworks.',
        mcpUrl: 'https://mcp.context7.com/mcp',
        transport: 'streamable-http',
        authStrategy: 'none',
        websiteUrl: 'https://context7.com',
        source: 'curated',
    },
    {
        slug: 'grep',
        name: 'Grep (Vercel)',
        description: 'Busca exemplos de código e trechos em repositórios do GitHub.',
        mcpUrl: 'https://mcp.grep.app',
        transport: 'streamable-http',
        authStrategy: 'none',
        websiteUrl: 'https://grep.app',
        source: 'curated',
    },
    {
        slug: 'sentry',
        name: 'Sentry',
        description: 'Consulta projetos, issues e erros do Sentry.',
        mcpUrl: 'https://mcp.sentry.dev/mcp',
        transport: 'streamable-http',
        authStrategy: 'oauth',
        websiteUrl: 'https://sentry.io',
        source: 'curated',
    },
    {
        slug: 'notion',
        name: 'Notion',
        description: 'Lê e organiza páginas e bases do Notion.',
        mcpUrl: 'https://mcp.notion.com/mcp',
        transport: 'streamable-http',
        authStrategy: 'oauth',
        websiteUrl: 'https://notion.so',
        source: 'curated',
    },
    {
        slug: 'stripe',
        name: 'Stripe',
        description: 'Consulta pagamentos, clientes e assinaturas no Stripe.',
        mcpUrl: 'https://mcp.stripe.com',
        transport: 'streamable-http',
        authStrategy: 'oauth',
        websiteUrl: 'https://stripe.com',
        source: 'curated',
    },
    {
        slug: 'linear',
        name: 'Linear',
        description: 'Consulta issues, projetos e times no Linear.',
        mcpUrl: 'https://mcp.linear.app/mcp',
        transport: 'streamable-http',
        authStrategy: 'oauth',
        websiteUrl: 'https://linear.app',
        source: 'curated',
    },
];

export function getCuratedProvider(slug: string): McpProvider | undefined {
    return CURATED_PROVIDERS.find(p => p.slug === slug);
}

/** Normalizes an arbitrary name into a slug usable inside generated JS. */
export function slugify(input: string): string {
    return input
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'mcp';
}

/** Derives a default slug from a remote URL host, e.g. mcp.svc.picpay.com → picpay. */
export function slugFromUrl(url: string): string {
    try {
        const host = new URL(url).host; // e.g. mcp.svc.picpay.com
        const parts = host.split('.').filter(Boolean);
        // Take the most meaningful label: skip generic prefixes.
        const generic = new Set(['mcp', 'api', 'www', 'com', 'br', 'app', 'dev', 'io', 'ai', 'co', 'net', 'org']);
        const meaningful = parts.filter(p => !generic.has(p));
        return slugify((meaningful.length ? meaningful : parts).join('-'));
    } catch {
        return slugify(url);
    }
}
