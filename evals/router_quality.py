"""Synthetic reasoning-depth check; memory eligibility is tested separately with fake stores."""
import argparse
import ast
import json
import statistics
import subprocess
import time
from unittest.mock import patch

from studio.core.utils.reply_modes.component import QwenThinkingRouter


CASES = (
    ('我明天有什么安排？', (), 'memory'),
    ('你好，我明天有什么安排？', (), 'memory'),
    ('你还记得我上次说喜欢什么吗？', (), 'memory'),
    ('我平时喜欢喝什么咖啡？', (), 'memory'),
    ('按我的口味，推荐一种咖啡。', (), 'memory'),
    ('结合我上次说过的偏好，讲个故事。', (), 'memory'),
    ('我上回决定去哪里旅行？', (), 'memory'),
    ('你好', (), 'direct'),
    ('请介绍一下你自己', (), 'direct'),
    ('讲一个小动物的故事。', (), 'direct'),
    ('咖啡一般有哪些种类？', (), 'direct'),
    ('什么是数学证明？', (), 'direct'),
    ('不用深入思考，简单介绍一下。', (), 'direct'),
    ('解释“请深入思考”这句话。', (), 'direct'),
    ('请深入思考一下这个问题。', (), 'memory_cot'),
    ('嗯，你能深度思考一下吗？', (), 'memory_cot'),
    ('计算 x 平方的不定积分。', (), 'direct'),
    ('结合我以前说过的预算，比较三个方案的风险和收益。', (), 'memory_cot'),
    ('帮我设计一套兼顾成本、可靠性和上线时间的迁移方案。', (), 'memory_cot'),
    ('周日呢', (('user', '我上次说过的周末计划是什么？'), ('assistant', '你想问哪一天？')), 'memory'),
    ('继续', (('user', '请深入思考这个方案的取舍。'), ('assistant', '我先分析了成本，还需要考虑可靠性。')), 'memory_cot'),
    ('为什么', (('user', '天空为什么是蓝色的？'), ('assistant', '因为大气散射。')), 'direct'),
    ('谢谢', (('user', '计算这个函数的积分。'), ('assistant', '推导已经完成。')), 'direct'),
    ('我想一想再说。', (), 'direct'),
    ('嗯，等一下。', (), 'direct'),
    ('帮我想想午饭吃什么。', (), 'direct'),
    ('分析一下我喜欢什么咖啡。', (), 'memory'),
    ('你能解释一下等待提示什么时候出现吗？', (), 'direct'),
    ('请认真回答，我上次预约的是周几？', (), 'memory'),
    ('比较拿铁和美式有什么区别。', (), 'direct'),
    ('帮我设计一个简短的生日祝福。', (), 'direct'),
    ('17加25是多少？', (), 'direct'),
    ('求 x 的平方的导数，只要结果。', (), 'direct'),
    ('证明勾股定理是什么意思？', (), 'direct'),
    ('我说的是查一下之前存的地址。', (), 'memory'),
    ('为什么？', (('user', '请分析三个部署方案的容错性。'),
                  ('assistant', '先说明术语：副本就是一份额外的数据拷贝。')), 'direct'),
    ('所以最后的结果是多少？', (('user', '请推导一个积分。'),
                               ('assistant', '推导完了，结果为四分之一。')), 'direct'),
    ('不用再展开，报个结论就好。', (('user', '请深入比较这两个方案。'),
                                 ('assistant', '分析显示第二个方案更合适。')), 'direct'),
    ('我下周二有什么安排？', (('user', '深入分析这个数学问题。'),
                             ('assistant', '这里要分三种情况讨论。')), 'memory'),
    ('我喜欢甜一点的，你还记得吗？', (('user', '请比较三套容灾架构。'),
                                   ('assistant', '我们从故障模式分析。')), 'memory'),
    ('嗯，我想一下。', (('user', '帮我推导这个积分。'),
                       ('assistant', '先确定积分区间，再处理边界。')), 'direct'),
    ('我有点难过，想找你聊聊。', (('user', '请做一个复杂的项目计划。'),
                               ('assistant', '需要考虑工期和资源冲突。')), 'direct'),
    ('继续讲。', (('user', '给我讲个睡前故事。'),
                 ('assistant', '小猫走进了一片发光的森林。')), 'direct'),
    ('继续。', (('user', '请推导最优调度算法。'),
               ('assistant', '只完成了约束建模，还需要推导算法和证明最优性。')), 'memory_cot'),
    ('和上一个比呢？', (('user', '拿铁喝起来是什么味道？'),
                       ('assistant', '奶味比较浓，美式则偏苦。')), 'direct'),
    ('那遇到网络分区和主节点故障同时发生呢？',
        (('user', '设计一个保证一致性的故障恢复协议。'),
         ('assistant', '我们刚讨论完单节点故障的情形。')), 'memory_cot'),
    ('结合延迟、成本和故障恢复要求，为两地三中心系统制定迁移步骤并评估风险。', (), 'memory_cot'),
    ('请证明这个递推算法对所有正整数都成立，并处理边界条件。', (), 'memory_cot'),
    ('一个服务只在高并发时偶发死锁，请根据调用链排查锁顺序并设计验证实验。', (), 'memory_cot'),
    ('解释一下“深度思考模式”是什么，不需要开启它。', (), 'direct'),
    ('这次请深入推理，不用急着回答。', (), 'memory_cot'),
)

# Separate paraphrases for a check after prompt selection, not few-shot examples.
HOLDOUT_CASES = (
    ('我前几天说过想买哪款耳机？', (), 'memory'),
    ('提醒一下，下周和朋友聚餐定在哪家店？', (), 'memory'),
    ('认真说，绿茶和红茶有什么区别？', (), 'direct'),
    ('帮我设计一句周末活动的宣传语。', (), 'direct'),
    ('从零到一积分 x 的平方，给个数就行。', (), 'direct'),
    ('“严格证明”这四个字是什么意思？', (), 'direct'),
    ('我先组织一下语言。', (), 'direct'),
    ('你先别分析，我只是想抱怨两句。', (), 'direct'),
    ('刚才你提到的缓存是什么意思？',
        (('user', '请深入论证这个复杂架构的正确性。'),
         ('assistant', '推导中还要考虑缓存和重试的行为。')), 'direct'),
    ('我一开始告诉你的预算是多少来着？',
        (('user', '深入权衡两个迁移方案。'),
         ('assistant', '我们要从长期成本和恢复能力分析。')), 'memory'),
    ('接着讲吧。', (('user', '讲个有趣的小故事。'),
                   ('assistant', '一只小狗发现了一把神奇的钥匙。')), 'direct'),
    ('不用长思考，请用一句话概括你的结论。',
        (('user', '证明这个算法会终止。'),
         ('assistant', '完整证明已经给出，算法一定终止。')), 'direct'),
    ('请用深度思考模式重新审视这个问题。', (), 'memory_cot'),
    ('能不能深入想一想再给我一个完整的论证？', (), 'memory_cot'),
    ('根据我之前说的业务量和预算，权衡扩容方案的成本、峰值延迟及故障恢复能力。', (), 'memory_cot'),
    ('分布式锁偶发出现两个持有者，推导可能的故障时序并设计保证互斥的修复。', (), 'memory_cot'),
    ('证明这个递推关系收敛，分类讨论参数范围并找出不收敛的反例。', (), 'memory_cot'),
    ('在不停机、不能丢数据且成本受限的条件下，设计跨云数据库迁移的验证和回滚策略。', (), 'memory_cot'),
    ('那么两个节点同时断连的情况该怎么证明？',
        (('user', '严密证明该协议在故障情况下仍然一致。'),
         ('assistant', '目前只证明了单节点故障，还没处理双节点故障。')), 'memory_cot'),
    ('好，把剩下的推导接着完成。',
        (('user', '请推导带约束的最优控制方案。'),
         ('assistant', '刚完成状态方程，还要推导约束下的最优性条件。')), 'memory_cot'),
)


def policy_at_revision(revision):
    """Read literal policy constants from a Git revision without executing it."""
    source = subprocess.check_output(
        ['git', 'show', f'{revision}:studio/harness/reply_modes/policy.py'], text=True)
    values = {}
    for node in ast.parse(source).body:
        if isinstance(node, ast.Assign):
            for name in node.targets:
                if isinstance(name, ast.Name) and name.id in {'SYSTEM', 'EXAMPLES'}:
                    values[name.id] = ast.literal_eval(node.value)
    return values['SYSTEM'], values['EXAMPLES']


def evaluate(router, cases=CASES):
    """Measure uncached depth decisions; expected memory labels do not test recall."""
    router._cache.clear()
    rows = []
    for text, history, expected in cases:
        start = time.monotonic()
        decision = router.classify(text, history=[{'role': role, 'content': content} for role, content in history])
        rows.append({'text': text, 'expected_depth': 'high' if expected == 'memory_cot' else 'none',
                     'actual_depth': decision.reasoning_effort, 'raw': decision.raw,
                     'wait_ms': round((time.monotonic() - start) * 1000, 1)})
    normal = [row for row in rows if row['expected_depth'] == 'none']
    deep = [row for row in rows if row['expected_depth'] == 'high']
    correct = sum(row['expected_depth'] == row['actual_depth'] for row in rows)
    times = sorted(row['wait_ms'] for row in rows)
    return {'correct': correct, 'total': len(rows),
            'ordinary_cases': len(normal), 'false_cot': sum(row['actual_depth'] == 'high' for row in normal),
            'deep_cases': len(deep), 'missed_cot': sum(row['actual_depth'] != 'high' for row in deep),
            'median_ms': statistics.median(times), 'p95_ms': times[int((len(times)-1)*.95)],
            'cases': rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', default='cpu')
    parser.add_argument('--assert-quality', action='store_true')
    parser.add_argument('--compare-ref', help='Compare a previous literal harness policy on the same cases and model.')
    parser.add_argument('--holdout', action='store_true', help='Use the separate paraphrase set.')
    args = parser.parse_args()
    router = QwenThinkingRouter(device=args.device)
    router.warmup()
    result = {'scope':'reasoning_depth_only'}
    cases = HOLDOUT_CASES if args.holdout else CASES
    if args.compare_ref:
        system, examples = policy_at_revision(args.compare_ref)
        with patch('studio.core.utils.reply_modes.component.SYSTEM', system), \
             patch('studio.core.utils.reply_modes.component.EXAMPLES', examples):
            result['baseline'] = evaluate(router, cases)
    result['current'] = evaluate(router, cases)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    current = result['current']
    if args.assert_quality and (current['correct'] / current['total'] < .9
                               or current['false_cot'] / max(1, current['ordinary_cases']) > .1
                               or current['missed_cot'] / max(1, current['deep_cases']) > .1):
        raise SystemExit('Depth smoke check failed; this is not a memory-recall or live-conversation benchmark.')


if __name__ == '__main__':
    main()
