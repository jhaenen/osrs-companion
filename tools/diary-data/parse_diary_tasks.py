import json
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))
WIKITEXT_DIR = os.path.join(HERE, "wikitext")
SPECS_PATH = os.path.join(HERE, "achievementDiariesSpecs.json")
OUT_PATH = os.path.join(HERE, "..", "..", "src", "data", "achievementDiaryTasks.json")

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
    "Varrock": "Varrock.wikitext",
    "Western Provinces": "Western_Provinces.wikitext",
    "Wilderness": "Wilderness.wikitext",
}

TIER_ORDER = ["Easy", "Medium", "Hard", "Elite"]

WIKILINK_RE = re.compile(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]")
BOLD_ITALIC_RE = re.compile(r"'''?'?")
REF_RE = re.compile(r"<ref[^>]*>.*?</ref>|<ref[^/]*/>", re.DOTALL)
COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
EFN_RE = re.compile(r"\{\{efn[^}]*\}\}")
# {{TemplateName|arg1|arg2|...}} - no nested braces expected in these tables.
TEMPLATE_CALL_RE = re.compile(r"\{\{([^{}|]+)((?:\|[^{}]*?)*)\}\}")


def render_scp(args):
    # {{SCP|Quest}} / {{SCP|Quest|32|link=y}} / {{SCP|Herblore|90|link=y}} /
    # {{SCP|combatachievement}} - skill/quest-point check with an icon+checkmark
    # in the rendered page. First arg is the skill (or "Quest"/"combatachievement"),
    # optional second arg is the required level - keep only the parts that
    # carry information not already in the surrounding sentence.
    first = args[0].strip() if args else ""
    level = args[1].strip() if len(args) > 1 and args[1].strip().isdigit() else None
    if first.lower() == "combatachievement":
        return ""
    if first == "Quest":
        return f"{level} Quest Points" if level else ""
    return f"{level} {first}" if level else first


def render_runereq(args):
    # {{RuneReq|Nature=20|Astral=40|Earth=300}} -> "20 Nature, 40 Astral, 300 Earth"
    parts = []
    for a in args:
        if "=" in a:
            rune, qty = a.split("=", 1)
            parts.append(f"{qty.strip()} {rune.strip()}")
    return ", ".join(parts)


def render_na(args):
    return args[0].strip() if args else "None"


TEMPLATE_RENDERERS = {
    "scp": render_scp,
    "runereq": render_runereq,
    "na": render_na,
}
# Templates that are purely visual (icons/footnote markers) with no text
# content worth keeping, once their surrounding sentence is intact.
TEMPLATE_STRIP_ONLY = {"boostable"}


def render_template(m):
    name = m.group(1).strip()
    raw_args = m.group(2)
    # group(2) is "|arg1|arg2|..." - split and drop empties.
    args = [a.strip() for a in raw_args.split("|") if a.strip() != ""]
    key = name.lower()
    if key in TEMPLATE_RENDERERS:
        return TEMPLATE_RENDERERS[key](args)
    if key in TEMPLATE_STRIP_ONLY:
        return ""
    return ""  # unknown template: strip, same as before


def clean_text(t):
    t = REF_RE.sub("", t)
    t = COMMENT_RE.sub("", t)
    t = EFN_RE.sub("", t)
    for _ in range(3):
        t = TEMPLATE_CALL_RE.sub(render_template, t)
    t = WIKILINK_RE.sub(r"\1", t)
    t = BOLD_ITALIC_RE.sub("", t)
    t = re.sub(r"<[^>]+>", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def parse_requirements(cell_text):
    # cell_text runs to the next row/table-end marker ("|-"/"|}"), which for
    # a bulleted cell is harmlessly dropped by the "starts with *" filter
    # below, but for a single-line cell (e.g. {{NA|None}}) would otherwise
    # get swept into the "no bullets" fallback as literal trailing junk.
    cell_text = re.split(r"\n\|[-}]", cell_text, maxsplit=1)[0]
    # Requirements cells are `*bullet` lines (one requirement per line).
    # {{NA|None}} appears as the whole cell with no bullets for "no requirements".
    lines = [ln.strip() for ln in cell_text.split("\n")]
    bullets = [ln[1:].strip() for ln in lines if ln.startswith("*")]
    if not bullets:
        cleaned = clean_text(cell_text)
        return [cleaned] if cleaned else []
    out = []
    for b in bullets:
        cleaned = clean_text(b)
        if cleaned:
            out.append(cleaned)
    return out


def extract_tier_tasks(text, tier):
    pat = re.compile(r'data-diary-tier="%s"(.*?)\n\|\}' % re.escape(tier), re.DOTALL)
    m = pat.search(text)
    if not m:
        return None
    block = m.group(1)
    rows = re.split(r"\n\|\s*(?=\d+\.\s)", block)
    tasks = []
    for row in rows[1:]:
        parts = row.split("\n|", 1)
        task_text = re.sub(r"^\s*\d+\.\s*", "", parts[0])
        requirements = parse_requirements(parts[1]) if len(parts) > 1 else []
        tasks.append({"name": clean_text(task_text), "requirements": requirements})
    return tasks


def main():
    specs = json.load(open(SPECS_PATH))
    result = {}
    problems = []
    for region, fname in REGION_FILES.items():
        text = open(os.path.join(WIKITEXT_DIR, fname)).read()
        region_out = {}
        for tier in TIER_ORDER:
            tier_spec = specs[region][tier]
            parsed = extract_tier_tasks(text, tier)
            n_spec = len(tier_spec["tasks"])
            if parsed is None:
                problems.append(f"{region}/{tier}: NO MATCH for table")
                parsed = []
            elif len(parsed) != n_spec:
                problems.append(f"{region}/{tier}: task count mismatch, wiki={len(parsed)} spec={n_spec}")
            region_out[tier] = {
                "complete": tier_spec["complete"],
                "tasks": [
                    {
                        "name": parsed[i]["name"] if i < len(parsed) else None,
                        "requirements": parsed[i]["requirements"] if i < len(parsed) else [],
                        **tier_spec["tasks"][i],
                    }
                    for i in range(n_spec)
                ],
            }
        result[region] = region_out

    with open(OUT_PATH, "w") as f:
        json.dump(result, f, indent=2)

    print("PROBLEMS:")
    for p in problems:
        print(" -", p)
    print(f"\nTotal problems: {len(problems)}")
    total_tasks = sum(len(result[r][t]["tasks"]) for r in result for t in result[r])
    print(f"Total tasks written: {total_tasks}")
    print(f"Output: {OUT_PATH}")


if __name__ == "__main__":
    main()
