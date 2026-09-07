"""Structural Markdown candidates, without executing or supplementing document text."""
from collections import Counter
import copy
import re

HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
IDENTIFIER = re.compile(r"^(?:\[([^\]\n]+)\]|((?:MAIN|SUB|A-D|A-M|[PDM]\d+)[A-Za-z0-9-]*))(?=\s|[｜|:：·]|$)", re.I)
DIMENSION = re.compile(r"(?<![\d.eE+-])(\d+)\s*[xX×*]\s*(\d+)(?![\d.eE])")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})(.*)$")
FIELD = re.compile(r"^(?:[-*+]\s+)?(?:\*\*)?([^:：]+?)(?:\*\*)?\s*[:：]\s*(.*)$")
REFERENCE_FIELDS = {"参考图", "参考图片", "参考图文件", "必须上传的参考图", "参考图声明", "references"}
SIZE_FIELDS = {"尺寸", "目标尺寸", "输出尺寸", "size"}
OUTPUT_FIELDS = {"输出名", "输出文件名", "输出名称", "output_name", "filename"}
NO_REFERENCES = {"无", "无参考图", "无需参考图", "none"}
FIELD_NAMES = {"size": "目标尺寸", "output_name": "输出名称", "reference_names": "参考图声明", "prompt": "Prompt"}


def error(field, code, message):
    return {"field": field, "code": code, "message": message}


def filenames(value):
    """Remove list syntax only; filename spelling/case and order remain exact."""
    names = []
    for line in value.splitlines():
        line = re.sub(r"^\s*[-*+]\s+", "", line).strip()
        for segment in re.split(r"(`[^`]*`)", line):
            if segment.startswith("`") and segment.endswith("`"):
                names.append(segment[1:-1])
                continue
            segment = re.sub(r"(^|[、，,；;]\s*)\d+(?:[.)]\s+|、\s*)", r"\1", segment)
            names.extend(part.strip() for part in re.split(r"[、，,；;]", segment) if part.strip())
    return names


def parse_markdown(content, md_version):
    sections = []
    current = None
    fence = None
    for line_number, line in enumerate(content.splitlines(), 1):
        marker = FENCE.match(line)
        if fence:
            if current is not None:
                current["lines"].append(line)
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            continue
        if marker:
            fence = marker[1]
        heading = HEADING.match(line) if not marker else None
        if heading:
            identity = IDENTIFIER.match(heading[2].replace("**", ""))
            if current is not None and len(heading[1]) <= current["level"]:
                current = None
            if identity:
                current = {"key": f"{md_version}:{line_number}", "level": len(heading[1]),
                           "title": heading[2].replace("**", ""), "lines": [], "id": identity[1] or identity[2]}
                sections.append(current)
                continue
        if current is not None:
            current["lines"].append(line)
    return [candidate for section in sections if (candidate := parse_section(section)) is not None]


def parse_section(section):
    title = section["title"]
    config = {"document_id": section["id"], "name": "", "prompt": "", "size": "",
              "output_name": None, "reference_names": None}
    values = {"size": [f"{w}x{h}" for w, h in DIMENSION.findall(title)],
              "output_name": re.findall(r"`([^`]+\.(?:png|jpe?g|webp|gif))`", title, re.I),
              "reference_names": [], "prompt": []}
    name = IDENTIFIER.sub("", title, count=1).strip(" ｜|:：·")
    name = DIMENSION.sub("", name)
    name = re.sub(r"`[^`]+`|\bpx\b", "", name).strip(" ｜|:：·")
    config["name"] = name
    errors = []
    if re.search(r"(?:^|[｜|（(\[【：:\s])(?:直通|无需生成)(?=$|[｜|）)\]】\s])", title):
        return None
    lines = section["lines"]
    index = 0
    prompt_section = False
    direct = True
    while index < len(lines):
        line = lines[index]
        heading = HEADING.match(line)
        if heading:
            direct = False
            prompt_section = heading[2].strip(" *:：").lower() in {"prompt", "提示词"}
        marker = FENCE.match(line)
        if marker:
            block = []
            index += 1
            while index < len(lines):
                closing = FENCE.match(lines[index])
                if closing and closing[1][0] == marker[1][0] and len(closing[1]) >= len(marker[1]) and not closing[2].strip():
                    break
                block.append(lines[index])
                index += 1
            if prompt_section:
                values["prompt"].append("\n".join(block).strip())
                if index == len(lines):
                    errors.append(error("prompt", "unclosed_prompt", "Prompt 代码围栏未闭合"))
            index += 1
            continue
        field = FIELD.match(line.strip())
        if field:
            key, value = field[1].strip().lower(), field[2].strip()
            if direct and key in {"生成方式", "处理方式", "状态", "生成"} and value.strip("*。 ") in {"直通", "无需生成"}:
                return None
            if key in REFERENCE_FIELDS:
                while index + 1 < len(lines) and (not lines[index + 1].strip() or re.match(r"^\s+(?:[-*+]\s+|\d+[.、)]\s*)", lines[index + 1])):
                    index += 1
                    value += "\n" + lines[index]
                names = [] if value.strip().lower() in NO_REFERENCES else filenames(value) or None
                values["reference_names"].append(names)
                if names is None:
                    errors.append(error("reference_names", "empty_declaration", "参考图声明为空；无图请明确声明无参考图"))
            elif key in SIZE_FIELDS:
                sizes = DIMENSION.findall(value)
                values["size"].extend(f"{w}x{h}" for w, h in sizes)
                if not sizes:
                    errors.append(error("size", "invalid_size", f"无法识别尺寸：{value}"))
            elif key in OUTPUT_FIELDS:
                values["output_name"].append(value.strip("`"))
            elif key in {"prompt", "提示词"}:
                prompt_section = True
                if value:
                    values["prompt"].append(value)
        elif direct and line.strip(" -*。") in {"直通", "无需生成"}:
            return None
        index += 1
    for field, entries in values.items():
        if entries:
            config[field] = entries[0]
            if any(entry != entries[0] for entry in entries[1:]):
                errors.append(error(field, "conflicting_field", f"{FIELD_NAMES[field]}存在冲突声明，请修正"))
    return {"key": section["key"], "config": config, "errors": errors, "skipped": False}


def validate_candidates(candidates, references):
    result = copy.deepcopy(candidates)
    ids = Counter(item["config"]["document_id"] for item in result)
    by_name = {}
    for reference in references:
        by_name.setdefault(reference["name"], []).append(reference)
    for item in result:
        config = item["config"]
        errors = item["errors"]
        if not config["document_id"].strip():
            errors.append(error("document_id", "missing_id", "缺少文档标识"))
        elif ids[config["document_id"]] > 1:
            errors.append(error("document_id", "duplicate_id", f"文档标识重复：{config['document_id']}"))
        if not config["prompt"].strip():
            errors.append(error("prompt", "missing_prompt", "缺少明确的 Prompt 区块"))
        if not re.fullmatch(r"[1-9]\d{0,4}x[1-9]\d{0,4}", config["size"]):
            errors.append(error("size", "invalid_size", "缺少有效目标尺寸，请填写宽x高（正整数）"))
        output = config["output_name"]
        if output is not None and (not output.strip() or len(output) > 255 or re.search(r'[/\\\x00]', output)):
            errors.append(error("output_name", "invalid_filename", "输出文件名无效"))
        item["matches"] = []
        names = config["reference_names"]
        if names is None:
            errors.append(error("reference_names", "missing_declaration", "缺少参考图声明；无图请明确选择无参考图"))
        for name in names or []:
            found = by_name.get(name, [])
            match = {"name": name, "status": "error", "upload_id": None, "reference": None}
            if not found:
                errors.append(error("reference_names", "missing_file", f"缺少参考图：{name}"))
            elif len(found) > 1:
                errors.append(error("reference_names", "duplicate_file", f"参考图同名冲突：{name}"))
            else:
                match.update(upload_id=found[0]["request_id"], reference=found[0]["reference"],
                             status="ready" if found[0]["reference"] else "pending")
            item["matches"].append(match)
        item["status"] = "error" if errors else "pending" if any(match["status"] == "pending" for match in item["matches"]) else "ready"
    return result
