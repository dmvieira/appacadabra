
function repairJson(text) {
    let result = '';
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            result += ch;
            escape = false;
        } else if (ch === '\\' && inString) {
            result += ch;
            escape = true;
        } else if (ch === '"') {
            inString = !inString;
            result += ch;
        } else if (inString && ch === '\n') {
            result += '\\n';
        } else if (inString && ch === '\r') {
            result += '\\r';
        } else if (inString && ch === '\t') {
            result += '\\t';
        } else {
            result += ch;
        }
    }
    return result;
}

function extractJson(response) {
    let text = response.trim();

    // 1. Remove markdown code blocks if present (non-greedy, requires closure)
    const markdownMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (markdownMatch) {
        text = markdownMatch[1].trim();
    } else {
        // Fallback for truncated code blocks or raw JSON
        const openBlock = text.indexOf('```');
        if (openBlock !== -1) {
            const start = text.indexOf('\n', openBlock) + 1 || openBlock + 3;
            text = text.substring(start);
        }
    }

    // 2. Find the first '{' and the matching '}'
    const startObj = text.indexOf('{');
    if (startObj === -1) return null;

    let depth = 0;
    let inString = false;
    let escape = false;
    let endObj = -1;

    for (let i = startObj; i < text.length; i++) {
        const ch = text[i];
        if (escape) {
            escape = false;
        } else if (ch === '\\' && inString) {
            escape = true;
        } else if (ch === '"') {
            inString = !inString;
        } else if (!inString) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    endObj = i;
                    break;
                }
            }
        }
    }

    if (endObj !== -1) {
        text = text.substring(startObj, endObj + 1);
    } else if (depth > 0) {
        // TRUNCATED JSON DETECTED
        throw new Error(`AI response was truncated (depth: ${depth}, inString: ${inString}). Length: ${text.length}`);
    }

    // 3. Repair common AI JSON issues
    text = repairJson(text);

    // 4. Attempt to parse
    try {
        return JSON.parse(text);
    } catch (e) {
        console.error("JSON Parse Error:", e.message);
        console.error("Snippet:", text.substring(Math.max(0, 305 - 50), 305 + 50));
        throw e;
    }
}

// Test cases
const cases = [
    {
        name: "Standard JSON",
        input: 'Sure! Here is the JSON: {"a": 1} Hope it helps.'
    },
    {
        name: "Truncated JSON (inside string)",
        input: '{"content": "This is truncated',
        shouldFail: true
    },
    {
        name: "Truncated JSON (inside object)",
        input: '{"a": {"b": 1',
        shouldFail: true
    },
    {
        name: "Braces inside code string",
        input: 'Here is your change: {"changes": [{"content": "function() { return 1; }"}]}'
    },
    {
        name: "JSON with literal newline",
        input: '{"msg": "hello\nworld"}'
    },
    {
        name: "Truncated after a brace inside a string (THE CULPRIT)",
        input: '{"code": "func() { return 1; } ',
        shouldFail: true
    }
];

cases.forEach(c => {
    console.log(`--- Test: ${c.name} ---`);
    try {
        const res = extractJson(c.input);
        console.log("Success:", JSON.stringify(res));
        if (c.shouldFail) console.error("FAILED: Should have thrown error");
    } catch (e) {
        console.log("Caught Expected Error:", e.message);
        if (!c.shouldFail) console.error("FAILED: Should not have thrown error");
    }
});
