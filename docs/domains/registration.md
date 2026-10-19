# Registration / Questionnaire / Materials 领域

## 目的

把“一个人参加这个活动”从草稿变成可执行的名单，并保存评审所需的材料。报名
不是一张固定表单，而是**由冻结赛制里的问卷定义**。

## 实体与值

- `Registration`：activity + user 的唯一身份；姓名/学号/院系/班级/联系方式；
  审核状态（draft/submitted/need_supplement/approved/rejected/withdrawn）。
- `QuestionnaireVersion`：属于某个冻结 definition；有 schema hash。
- `QuestionnaireResponse`：registration + version + questionnaire key；答案与
  提交状态。
- `SubmissionFile`：按 question key 或 legacy purpose 归属；版本、当前标记、
  所有权（singer/program/group）。
- `MaterialCheck`：需要审核的材料项，带 file purpose、状态与审核记录。

## 生命周期

```text
draft ─submit─▶ submitted ─review─▶ approved | need_supplement | rejected
                                     │
                                     └─补充材料─▶ submitted
```

- 报名审核是**人员准入**；材料审核是**交付物准入**，两者不能互相替代。
- 名单只有在“报名截止/审核完成/彩排或更后”才是 FINAL；在此之前是 UNKNOWN，
  不是 0（LIFE-07）。

## 不变量

- **REG-01** 一个 activity 内一个 user 只能有一条报名；学号唯一（条件唯一）。
- **REG-02** 问卷答案绑定 `(registration, version, key)`；换版不覆盖历史。
- **REG-03** 文件槽位由 question/purpose 身份决定；替换只影响自己的槽位。
- **REG-04** 私有材料只经受控媒体网关读取（AUTH-04）；删除/清理是领域命令。
- **REG-05** 审核动作记录操作者、时间、原因；锁定/归档后不可静默修改。

## 事件

`RegistrationStarted`、`RegistrationSubmitted`、`RegistrationApproved`、
`RegistrationNeedsSupplement`、`RegistrationRejected`、
`QuestionnaireAnswered`、`MaterialUploaded`、`MaterialReviewed`、
`RosterFinalized`。

## v1 参考

- `singer_contest/models.py::SingerRegistration`
- `questionnaire/models.py`、`questionnaire/registration.py`
- `files/models.py::SubmissionFile`、`files/services.py`
- 事故：`docs/incidents/unknown-roster-deferred.md`

## Plus 要求

- 问卷定义来自已冻结的 definition，不允许运行时从当前 DRAFT 读取。
- 名单确定状态是显式事实，执行命令必须要求它。
- 文件槽位以业务身份（question/binding）命名，不以“第几个文件”命名。
- 删除报名会销毁事实，只能走显式清理命令（AUTH-05）。

## 待决问题

- 换版沿用答案的语义边界（type/binding/file purpose）是否要支持显式迁移？
  v1 只搬自由文本，v2 可以设计一个可审计的 `AnswerMigration`。
- 外部报名导入（Excel）是否属于 v2.0？若属于，需要独立的导入命令与去重规则。
