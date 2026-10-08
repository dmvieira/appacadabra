import { deriveRequirements, serializeRequirements, parseRequirements } from '../deriveRequirements';

describe('deriveRequirements', () => {
    it('returns empty for empty input', () => {
        expect(deriveRequirements('')).toEqual({ capabilities: [], mcps: [] });
        expect(deriveRequirements(null)).toEqual({ capabilities: [], mcps: [] });
    });

    it('detects capability display names', () => {
        const code = `AppacadabraCamera.takePhoto("cb");
AppacadabraContacts.search("João", "cb2");
AppacadabraUI.toast("hi");`;
        const req = deriveRequirements(code);
        expect(req.capabilities).toEqual(['Camera', 'Contacts', 'UI']);
    });

    it('excludes MCP from capabilities and captures connector slugs', () => {
        const code = `
AppacadabraMCP.listTools("picpay", "onTools");
AppacadabraMCP.callTool('notion', 'search', {}, 'onResult');
AppacadabraMCP.connect("picpay", "cb");
`;
        const req = deriveRequirements(code);
        expect(req.capabilities).toEqual([]);
        expect(req.mcps).toEqual(['notion', 'picpay']);
    });

    it('ignores the bare Appacadabra namespace', () => {
        expect(deriveRequirements('window.Appacadabra = {};').capabilities).toEqual([]);
    });

    it('round-trips through serialize/parse', () => {
        const req = { capabilities: ['Camera'], mcps: ['picpay'] };
        const s = serializeRequirements(req);
        expect(parseRequirements(s.capabilities, s.mcps)).toEqual(req);
    });

    it('parses garbage safely', () => {
        expect(parseRequirements('not json', undefined)).toEqual({ capabilities: [], mcps: [] });
    });
});
