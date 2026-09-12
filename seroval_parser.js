function parseSerovalNode(node) {
    if (!node || typeof node !== 'object') return node;
    // t: 0 -> number
    if (node.t === 0) return node.s;
    // t: 1 -> string
    if (node.t === 1) return node.s;
    // t: 2 -> primitive (s: 0 -> null, s: 1 -> undefined, s: 2 -> true, s: 3 -> false)
    if (node.t === 2) {
        if (node.s === 0) return null;
        if (node.s === 1) return undefined;
        if (node.s === 2) return true;
        if (node.s === 3) return false;
        return null;
    }
    // t: 9 -> array
    if (node.t === 9 && Array.isArray(node.a)) {
        return node.a.map(parseSerovalNode);
    }
    // t: 10 -> object
    if (node.t === 10 && node.p && Array.isArray(node.p.k) && Array.isArray(node.p.v)) {
        const obj = {};
        for (let i = 0; i < node.p.k.length; i++) {
            obj[node.p.k[i]] = parseSerovalNode(node.p.v[i]);
        }
        return obj;
    }
    return node;
}

export function parseSerovalResponse(raw) {
    const root = parseSerovalNode(raw);
    if (root && root.result) {
        return root.result;
    }
    if (root && root.error) {
        throw new Error(root.error.message || JSON.stringify(root.error));
    }
    return root;
}
