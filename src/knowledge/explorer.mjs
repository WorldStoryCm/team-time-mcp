// Generated from Team Time src/features/knowledge/explorer.ts by export-knowledge-mcp.mts.
function el(tag, text, cls) {
    const element = document.createElement(tag);
    if (text !== undefined)
        element.textContent = text;
    if (cls)
        element.className = cls;
    return element;
}
function button(text, click, cls) {
    const element = el("button", text, cls);
    element.type = "button";
    element.addEventListener("click", click);
    return element;
}
function field(title, control) {
    const label = el("label", undefined, "kn-field");
    control.setAttribute("aria-label", title);
    label.append(el("span", title), control);
    return label;
}
const errorText = (e) => e instanceof Error ? e.message : "Request failed. Please retry.";
const stamp = (iso) => new Date(iso).toLocaleString();
const labels = {
    decision: "Decisions",
    fact: "Facts",
    constraint: "Constraints",
    question: "Questions",
    summary: "Summaries",
};
function graph(entries, project, open) {
    const tree = el("div", undefined, "kn-graph");
    tree.setAttribute("aria-label", "Project knowledge graph");
    tree.append(el("strong", project, "kn-root"));
    const groups = el("div", undefined, "kn-branches");
    for (const [category, name] of Object.entries(labels)) {
        const notes = entries.filter((e) => e.category === category);
        if (!notes.length)
            continue;
        const group = el("div", undefined, "kn-branch");
        group.append(el("span", name, "kn-node"));
        const leaves = el("div", undefined, "kn-leaves");
        for (const note of notes) {
            const leaf = el("div", undefined, "kn-leaf");
            leaf.append(button(note.title, () => open(note.noteId), "kn-note"));
            for (const link of note.links) {
                const target = entries.find((e) => e.noteId === link.noteId);
                const edge = button(link.relation +
                    " → " +
                    (target?.title ?? "Linked note") +
                    " · v" +
                    link.revision, () => open(link.noteId, link.revision), "kn-edge");
                edge.title = link.reason;
                leaf.append(edge);
            }
            leaves.append(leaf);
        }
        group.append(leaves);
        groups.append(group);
    }
    tree.append(groups);
    return tree;
}
export function mountKnowledge(root, api, project, canReview) {
    const initial = new URL(location.href);
    let view = initial.searchParams.get("proposal")
        ? "Review"
        : (initial.searchParams.get("view") ?? "List");
    if (!["List", "Graph", "Review"].includes(view))
        view = "List";
    let query = initial.searchParams.get("q") ?? "", filter = "pending";
    let entries = [], cursor = null, generation = 0, detailGeneration = 0, disposed = false;
    const nav = el("nav", undefined, "kn-tabs");
    nav.setAttribute("aria-label", "Knowledge views");
    const search = el("input");
    search.type = "search";
    search.placeholder = "Search knowledge";
    search.value = query;
    search.setAttribute("aria-label", "Search knowledge");
    const toolbar = el("div", undefined, "kn-toolbar");
    const stateSelect = el("select");
    stateSelect.setAttribute("aria-label", "Review status");
    for (const v of ["pending", "approved", "merged", "rejected"])
        stateSelect.add(new Option(v[0].toUpperCase() + v.slice(1), v));
    const submitSearch = el("form", undefined, "kn-search");
    submitSearch.append(search);
    const layout = el("div", undefined, "kn-layout"), results = el("div", undefined, "kn-results"), panel = el("article", undefined, "kn-detail");
    const message = el("div", undefined, "kn-message");
    message.setAttribute("aria-live", "polite");
    panel.hidden = true;
    layout.append(results, panel);
    toolbar.append(nav, stateSelect, submitSearch);
    root.replaceChildren(toolbar, message, layout);
    const href = () => new URL(location.href);
    function navigate(modify, replace = false) {
        const url = href();
        modify(url);
        if (url.href !== location.href)
            history[replace ? "replaceState" : "pushState"](null, "", url);
    }
    function clearPanel() {
        detailGeneration++;
        panel.hidden = true;
        panel.replaceChildren();
        layout.classList.remove("kn-selected");
    }
    function select(kind, id, revision) {
        navigate((url) => {
            url.searchParams.delete("note");
            url.searchParams.delete("proposal");
            url.searchParams.delete("revision");
            url.searchParams.set(kind, id);
            if (revision)
                url.searchParams.set("revision", String(revision));
        });
        void loadDetail(kind, id, revision);
    }
    function closePanel() {
        clearPanel();
        navigate((url) => {
            url.searchParams.delete("note");
            url.searchParams.delete("proposal");
            url.searchParams.delete("revision");
        });
        results.focus();
    }
    const tabs = ["List", "Graph", "Review"].map((name) => {
        const btn = button(name, () => {
            view = name;
            clearPanel();
            navigate((url) => {
                url.searchParams.set("view", name);
                url.searchParams.delete("note");
                url.searchParams.delete("proposal");
                url.searchParams.delete("revision");
            });
            void refresh();
        });
        nav.append(btn);
        return btn;
    });
    function drawList() {
        results.replaceChildren();
        if (!entries.length) {
            results.append(el("p", query
                ? "No matching records."
                : view === "Review"
                    ? "No proposals with this status."
                    : "No approved knowledge yet.", "kn-empty"));
        }
        else if (view === "Graph")
            results.append(graph(entries, project, (id, revision) => select("note", id, revision)));
        else {
            for (const [category, name] of Object.entries(labels)) {
                const group = entries.filter((e) => e.category === category);
                if (!group.length)
                    continue;
                results.append(el("h3", name));
                for (const item of group) {
                    const row = button("", () => view === "Review"
                        ? select("proposal", item.id)
                        : select("note", item.noteId), "kn-row");
                    row.append(el("strong", item.title), el("small", view === "Review" ? item.status : "v" + item.revision), el("span", item.publishedContent ?? item.content));
                    results.append(row);
                }
            }
        }
        if (cursor)
            results.append(button("Load more", () => void refresh(true), "kn-more"));
    }
    async function refresh(more = false) {
        const turn = ++generation;
        tabs.forEach((t, i) => t.setAttribute("aria-pressed", String(["List", "Graph", "Review"][i] === view)));
        stateSelect.hidden = view !== "Review";
        if (!more) {
            entries = [];
            cursor = null;
            results.replaceChildren();
        }
        message.textContent = "Loading…";
        try {
            const page = await api.list({
                view: view === "Review" ? "review" : "notes",
                status: view === "Review" ? filter : undefined,
                query,
                cursor: more ? (cursor ?? undefined) : undefined,
            });
            if (turn !== generation || disposed)
                return;
            entries = more ? [...entries, ...page.items] : page.items;
            cursor = page.nextCursor;
            message.textContent = "";
            drawList();
        }
        catch (e) {
            if (turn !== generation || disposed)
                return;
            message.replaceChildren(el("span", errorText(e)), button("Retry", () => void refresh(more)));
        }
    }
    async function reviewForm(entry, turn) {
        const form = el("form", undefined, "kn-review");
        const action = el("select");
        action.add(new Option("Approve", "approve"));
        action.add(new Option("Merge into a note", "merge"));
        action.add(new Option("Reject", "reject"));
        const destination = el("select"), merged = el("textarea"), why = el("textarea");
        why.required = true;
        why.maxLength = 2000;
        merged.maxLength = 5000;
        merged.value = entry.content;
        const comparison = el("div", undefined, "kn-comparison");
        const destinationField = field("Destination note", destination), mergedField = field("Resulting text", merged);
        const feedback = el("p");
        feedback.setAttribute("role", "status");
        const submit = el("button", "Save decision", "kn-primary");
        submit.type = "submit";
        submit.disabled = true;
        form.append(field("Decision", action), destinationField, comparison, mergedField, field("Reason and source check", why), submit, feedback);
        panel.append(form);
        const options = new Map();
        function sync() {
            const merging = action.value === "merge";
            destinationField.hidden = mergedField.hidden = !merging;
            destination.required = merged.required = merging;
            const target = options.get(destination.value);
            comparison.replaceChildren();
            if (target && (merging || entry.target))
                comparison.append(el("h4", "Current · v" + target.revision), el("p", target.publishedContent), el("small", target.evidence));
        }
        action.onchange = sync;
        destination.onchange = sync;
        sync();
        let next = null;
        try {
            do {
                const page = await api.list({ limit: 100, cursor: next ?? undefined });
                if (turn !== detailGeneration || disposed)
                    return;
                for (const note of page.items) {
                    if (entry.target && note.noteId !== entry.target.noteId)
                        continue;
                    options.set(note.noteId, note);
                    destination.add(new Option(note.title + " · v" + note.revision, note.noteId));
                }
                next = page.nextCursor;
            } while (next);
            if (entry.target)
                destination.value = entry.target.noteId;
            else {
                destination.add(new Option("Select a note", ""), 0);
                destination.value = "";
            }
            sync();
        }
        catch (e) {
            feedback.textContent = errorText(e);
        }
        submit.disabled = false;
        form.onsubmit = async (event) => {
            event.preventDefault();
            if (submit.disabled)
                return;
            const choice = action.value, target = options.get(destination.value);
            if (choice === "merge" && !target)
                return;
            submit.disabled = true;
            try {
                await api.decide(entry.id, {
                    action: choice,
                    reason: why.value,
                    ...(choice === "merge" && target
                        ? {
                            mergedContent: merged.value,
                            target: { noteId: target.noteId, revision: target.revision },
                        }
                        : {}),
                });
                if (disposed || turn !== detailGeneration)
                    return;
                await Promise.all([refresh(), loadDetail("proposal", entry.id)]);
            }
            catch (e) {
                feedback.textContent = errorText(e);
                submit.disabled = false;
            }
        };
    }
    async function loadDetail(kind, id, revision) {
        const turn = ++detailGeneration;
        panel.hidden = false;
        layout.classList.add("kn-selected");
        panel.replaceChildren(button("Close", closePanel, "kn-close"), el("p", "Loading…"));
        try {
            const note = kind === "note" ? await api.note(id) : null;
            const entry = note
                ? revision
                    ? note.history.find((item) => item.revision === revision)
                    : note.current
                : await api.proposal(id);
            if (!entry)
                throw new Error("This revision is unavailable.");
            if (turn !== detailGeneration || disposed)
                return;
            const heading = el("h2", entry.title);
            heading.tabIndex = -1;
            panel.replaceChildren(button("Close", closePanel, "kn-close"), el("small", kind === "note"
                ? entry.category + " · v" + entry.revision
                : "Proposal · " + entry.status), heading);
            heading.focus({ preventScroll: true });
            panel.append(el("p", entry.publishedContent ?? entry.content, "kn-body"), el("h4", "Evidence"), el("p", entry.evidence, "kn-body"), el("small", "Submitted by " + entry.author + " · " + stamp(entry.createdAt)));
            if (note && entry.revision !== note.current.revision)
                panel.append(button("Open current revision", () => select("note", id), "kn-link"));
            for (const link of entry.links)
                panel.append(button(link.relation + " · v" + link.revision + " — " + link.reason, () => select("note", link.noteId, link.revision), "kn-link"));
            if (entry.reason)
                panel.append(el("h4", "Decision"), el("p", entry.reason), el("small", entry.reviewer + " · " + stamp(entry.reviewedAt)));
            if (kind === "proposal" && entry.noteId)
                panel.append(button("Open published note", () => select("note", entry.noteId), "kn-link"));
            if (note) {
                panel.append(el("h4", "Revision history"));
                for (const item of note.history) {
                    const d = el("details");
                    d.append(el("summary", "v" +
                        item.revision +
                        " · " +
                        item.status +
                        " · " +
                        stamp(item.reviewedAt)), el("h4", "Published text"), el("p", item.publishedContent), el("h4", "Original proposal"), el("p", item.content), el("h4", "Source"), el("p", item.evidence), el("p", item.reason), el("small", item.author + " → " + item.reviewer));
                    panel.append(d);
                }
            }
            if (entry.status === "pending") {
                const compared = await api.check(entry.id);
                if (turn !== detailGeneration || disposed)
                    return;
                panel.append(el("h4", "Compare current knowledge"));
                if (!compared.candidates.length)
                    panel.append(el("p", "No matching notes found."));
                for (const { basis, note } of compared.candidates) {
                    const card = el("details");
                    card.open = basis === "same_title" || basis === "target";
                    card.append(el("summary", note.title +
                        " · v" +
                        note.revision +
                        " · " +
                        basis.replace("_", " ")), el("p", note.publishedContent), el("small", note.evidence));
                    panel.append(card);
                }
                if (canReview)
                    await reviewForm(entry, turn);
            }
        }
        catch (e) {
            if (turn === detailGeneration && !disposed)
                panel.replaceChildren(button("Close", closePanel), el("p", errorText(e)), button("Retry", () => void loadDetail(kind, id, revision)));
        }
    }
    function applyLocation() {
        const params = href().searchParams;
        view = params.get("view") ?? (params.has("proposal") ? "Review" : "List");
        query = params.get("q") ?? "";
        search.value = query;
        clearPanel();
        void refresh();
        if (params.has("note"))
            void loadDetail("note", params.get("note"), Number(params.get("revision")) || undefined);
        else if (params.has("proposal"))
            void loadDetail("proposal", params.get("proposal"));
    }
    results.tabIndex = -1;
    function runSearch() {
        query = search.value.trim();
        navigate((url) => {
            if (query)
                url.searchParams.set("q", query);
            else
                url.searchParams.delete("q");
        }, true);
        void refresh();
    }
    let delay;
    search.oninput = () => {
        clearTimeout(delay);
        delay = setTimeout(runSearch, 180);
    };
    submitSearch.onsubmit = (e) => {
        e.preventDefault();
        clearTimeout(delay);
        runSearch();
    };
    stateSelect.onchange = () => {
        filter = stateSelect.value;
        clearPanel();
        navigate((url) => url.searchParams.delete("proposal"), true);
        void refresh();
    };
    window.addEventListener("popstate", applyLocation);
    applyLocation();
    return () => {
        disposed = true;
        clearTimeout(delay);
        window.removeEventListener("popstate", applyLocation);
        root.replaceChildren();
    };
}
