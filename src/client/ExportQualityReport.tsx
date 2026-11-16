import {t, useLocale, systemMessage, formatDate} from './i18n.ts';
import type {LocalQualityReport} from '../workflows/local-quality.ts';

const labels={pass:'已检查',fail:'阻断',unchecked:'未检查','needs-review':'需查看'};
/** Historical evidence belongs to the exported snapshot even after the editor advances. */
export function ExportQualityReport({report,revision}:{report:LocalQualityReport;revision:number}){
  useLocale();
  const bound=report.revision===revision;
  return <details className="vs-media-advanced" data-export-quality>
    <summary>{t("本次导出检查 · ")}{!bound?t("版本不匹配"):report.decision==='fail'?t("发现阻断项"):report.decision==='needs-review'?t("有待查看项目"):t("检查范围内未发现异常")}</summary>
    <p>{t("检查工程 v{revision} · 实际分析 {checked} / {requested} 帧 · {date}",{revision:report.revision,checked:report.scope.checkedFrames.length,requested:report.scope.requestedFrames.length,date:formatDate(report.checkedAt)})}</p>
    {!bound&&<p className="vs-inline-error" role="alert">{t("报告与成片版本不一致，不能作为此成片的检查结果。")}</p>}
    <p className="vs-media-help">{t("此报告保留本次导出时的抽样结果，后续工程编辑不会改写它；未检查范围不代表通过。")}</p>
    <p className="vs-export-path" title={report.candidateHash}>{t("内容 SHA-256：")}{report.candidateHash}</p>
    <ul>{report.checks.filter(check=>check.status!=='pass').map(check=><li key={check.id}>{t(labels[check.status])} · {systemMessage(check.message)}</li>)}</ul>
    <p>{t("已分析绝对帧：")}{report.scope.checkedFrames.map(frame=>frame.frame).join(t('、'))||t("无")}</p>
    {report.scope.unsampledShots.length>0&&<p>{t("没有已分析帧的镜头：")}{report.scope.unsampledShots.join(t('、'))}</p>}
    <ul>{report.scope.unchecked.map(item=><li key={item}>{systemMessage(item)}</li>)}</ul>
  </details>;
}
