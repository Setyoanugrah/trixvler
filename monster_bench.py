#!/usr/bin/env python3
import argparse
import base64
import json
import re
import sys
import time

import vision_cv


TASKS = [
    'twins', 'same_wings', 'missing', 'extra', 'no_wings', 'parts',
    'eyes', 'stripes', 'upside', 'lying', 'biggest_smallest',
    'different_body',
]

PROMPTS = [
    "Tap its 2 TWINS. Same parts as this one. Colour and face don't count.",
    'Tap the 2 with the same WINGS as this one. Only the wings count.',
    'Tap the 2 copies with a part MISSING. Copies of this monster with one part gone.',
    'Tap the 2 copies with an EXTRA PART. Copies of this monster with one part added.',
    'Tap the 2 monsters with NO WINGS. All the others have wings.',
    'Tap the 2 with ARMS and LEGS. They have both.',
    'Tap the 2 monsters with 2 EYES. Count the eyes.',
    'Tap the 2 monsters with STRIPES. Only the pattern on the body counts.',
    'Tap the 2 monsters UPSIDE DOWN. Standing on their heads.',
    'Tap the 2 monsters LYING ON THEIR SIDE. Not standing up.',
    'Tap the BIGGEST and the SMALLEST. One big, one small.',
    'Tap the 2 with a DIFFERENT BODY. Their body shape is not like the others.',
]


def tutorial_cases(path):
    source = open(path, encoding='utf-8').read()
    match = re.search(r'var Z = (\[.*?\]), W =', source, re.S)
    if not match:
        raise ValueError('tutorial answers not found')
    answers = json.loads(match.group(1))
    cards = re.findall(
        r'<div class="card" data-i="(\d+)">(.*?)'
        r'(?=<div class="card"|<div class="tips")', source, re.S)
    cases = []
    for raw_index, card in cards:
        index = int(raw_index)
        images = re.findall(r'data:image/webp;base64,([^"\s]+)', card)
        if len(images) < 2:
            raise ValueError(f'incomplete tutorial card {index}')
        expected = {
            min(
                range(8),
                key=lambda i: (
                    (vision_cv.CENTERS[i][0] - point[0]) ** 2
                    + (vision_cv.CENTERS[i][1] - point[1]) ** 2
                ),
            )
            for point in answers[index]
        }
        cases.append({
            'index': index,
            'prompt': PROMPTS[index],
            'ref': base64.b64decode(images[0]),
            'scene': base64.b64decode(images[1]),
            'expected': expected,
        })
    return sorted(cases, key=lambda case: case['index'])


def parser_checks():
    cases = [
        ('Tap the 2 monsters with 1 EYE', 'eyes', 2, 1),
        ('Tap the 2 monsters with 3 EYES', 'eyes', 2, 3),
        ('Tap the 2 with LEGS and WINGS', 'parts', 2, None),
        ('Tap the 2 BIGGEST', 'biggest', 2, None),
        ('Tap the 2 monsters WITHOUT WINGS', 'no_wings', 2, None),
    ]
    for prompt, task, count, eyes in cases:
        parsed = vision_cv.parse_task_spec(prompt)
        actual = (parsed['task'], parsed['count'], parsed['eye_count'])
        expected = (task, count, eyes)
        if actual != expected:
            raise AssertionError(f'parse {prompt!r}: {actual} != {expected}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('tutorial_html')
    args = parser.parse_args()
    parser_checks()
    cases = tutorial_cases(args.tutorial_html)
    if len(cases) != 12:
        raise ValueError(f'expected 12 tutorial cases, got {len(cases)}')

    passed = 0
    started = time.monotonic()
    for case in cases:
        t0 = time.monotonic()
        out = vision_cv.solve(
            vision_cv.decode(base64.b64encode(case['scene']).decode()),
            vision_cv.decode(base64.b64encode(case['ref']).decode()),
            case['prompt'],
        )
        expected_task = TASKS[case['index']]
        predicted = set(out.get('indices', []))
        ok = (
            out.get('ok') is True
            and out.get('task') == expected_task
            and predicted == case['expected']
        )
        passed += int(ok)
        status = 'PASS' if ok else 'FAIL'
        print(
            f'{case["index"] + 1:02} {status} task={out.get("task")} '
            f'want={sorted(case["expected"])} got={sorted(predicted)} '
            f'method={out.get("method")} confidence={out.get("confidence")} '
            f'ms={int((time.monotonic() - t0) * 1000)}'
        )
    elapsed = time.monotonic() - started
    print(f'{passed}/{len(cases)} passed in {elapsed:.1f}s')
    return 0 if passed == len(cases) else 1


if __name__ == '__main__':
    sys.exit(main())
