import json
import re
import sys

SCRATCH = "/tmp/claude-1000/-home-jhaenen-Documenten-Programmeren-desktop-ai/8b00e651-59ec-4304-8c7f-90695e45ebaf/scratchpad"

REGION_FILES = {
    "Ardougne": "Ardougne.wikitext",
    "Desert": "Desert.wikitext",
    "Falador": "Falador.wikitext",
    "Fremennik": "Fremennik.wikitext",
    "Kandarin": "Kandarin.wikitext",
    "Karamja": "Karamja.wikitext",
    "Kourend & Kebos": "Kourend___Kebos.wikitext",
    "Lumbridge & Draynor": "Lumbridge___Draynor.wikitext",
    "Morytania": "Morytania.wikitext",
    "Varrock": "varrock_diary.wikitext",  # already fetched earlier, different name/location
    "Western Provinces": "Western_Provinces.wikitext",
    "Wilderness": "Wilderness.wikitext",
}

TIER_ORDER = ["Easy", "Medium", "Hard", "Elite"]

WIKILINK_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]")
BOLD_ITALIC_RE = re.compile(r"'''?'?")
REF_RE = re.compile(r"<ref[^>]*>.*?</ref>|<ref[^/]*/>", re.DOTALL)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
EFN_RE = re.compile(r"\{\{efn[^}]*\}\}")
TEMPLATE_RE = re.compile(r"\{\{[^{}]*\}\}")


def clean_text(t):
    t = REF_RE.sub("", t)
    t = COMMENT_RE.sub("", t)
    t = EFN_RE.sub("", t)
    # repeatedly strip simple templates (no nested braces) like {{SCP|...}}
    for _ in range(3):
        t = TEMPLATE_RE.sub("", t)
    t = WIKILINK_RE.sub(r"\1", t)
    t = BOLD_ITALIC_RE.sub("", t)
    t = re.sub(r"<[^>]+>", "", t)  # stray html tags
    t = re.sub(r"\s+", " ", t).strip()
    return t


def extract_tier_tasks(text, tier):
    # find the table block with data-diary-tier="Tier"
    pat = re.compile(
        r'data-diary-tier="%s"(.*?)\n\|\}' % re.escape(tier), re.DOTALL
    )
    m = pat.search(text)
    if not m:
        return None
    block = m.group(1)
    # split into rows on lines starting with |N.
    rows = re.split(r"\n\|\s*(?=\d+\.\s)", block)
    tasks = []
    for row in rows[1:]:  # first split chunk is header/junk before first task
        # task text is up to first \n| (start of requirements cell) at line start
        row_text = row.split("\n|", 1)[0]
        row_text = re.sub(r"^\s*\d+\.\s*", "", row_text)
        tasks.append(clean_text(row_text))
    return tasks


def main():
    specs = json.load(open(f"{SCRATCH}/achievementDiariesSpecs.json"))
    result = {}
    problems = []
    for region, fname in REGION_FILES.items():
        path = f"{SCRATCH}/{fname}" if "/" not in fname and not fname.startswith("varrock") else f"{SCRATCH}/{fname}"
        try:
            text = open(f"{SCRATCH}/diary_wikitext/{fname}").read()
        except FileNotFoundError:
            text = open(f"{SCRATCH}/{fname}").read()
        region_out = {}
        for tier in TIER_ORDER:
            tier_spec = specs[region][tier]
            names = extract_tier_tasks(text, tier)
            n_spec = len(tier_spec["tasks"])
            if names is None:
                problems.append(f"{region}/{tier}: NO MATCH for table")
                names = []
            elif len(names) != n_spec:
                problems.append(
                    f"{region}/{tier}: task count mismatch, wiki={len(names)} spec={n_spec}"
                )
            region_out[tier] = {
                "complete": tier_spec["complete"],
                "tasks": [
                    {"name": names[i] if i < len(names) else None, **tier_spec["tasks"][i]}
                    for i in range(n_spec)
                ],
            }
        result[region] = region_out

    with open(f"{SCRATCH}/achievementDiaryTasksMerged.json", "w") as f:
        json.dump(result, f, indent=2)

    print("PROBLEMS:")
    for p in problems:
        print(" -", p)
    print(f"\nTotal problems: {len(problems)}")
    total_tasks = sum(
        len(result[r][t]["tasks"]) for r in result for t in result[r]
    )
    print(f"Total tasks written: {total_tasks}")


if __name__ == "__main__":
    main()
