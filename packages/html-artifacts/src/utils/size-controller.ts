/**
 * 注入 iframe 的尺寸控制器源码。写成一段显式的字符串是故意的：生产打包因此是确定的，
 * 测试跑的也正是这一份源码。脚本里的两个缺省值从常量表插进来，全包只有一处出处。
 *
 * 控制器管着 iframe 报给宿主的两个轴，因为两个轴都会被宿主反馈回 iframe（高变成 frame 高，
 * 宽变成 frame 宽加一个缩放比）。任何「本身就是视口的函数」的测量都因此闭成一个环，环必须在这里断开
 * ——宿主分不出跑飞和真的在长高。
 *
 * - 高：溢出时的 `scrollHeight` 是单调地板，连续两轮随视口等量增长就冻结在当前 clientHeight，
 *   `maxReportedHeight` 是硬上限。
 * - 宽：`100vw` 子元素、百分比定位的装饰、被祖先裁掉的内容，都会在宿主加宽 frame 时跟着长。
 *   连续两轮增长就冻结回宿主的首个可用宽；`maxWidthRatio` 是硬上限。宽的冻结对 `invalidate()`
 *   是粘滞的——宽随视口长的文档不会因为一次 DOM 补丁就不再这么长，每次 mutation 解冻等于重启跑飞。
 */
import { HtmlArtifactDefaults } from '../contract/constants.js'

/** 尺寸控制器的工厂源码；`(maxReportedHeight, maxWidthRatio)` 两个参数缺省取常量表里的值。 */
export const HTML_ARTIFACT_SIZE_CONTROLLER_FACTORY_SOURCE = `function(maxReportedHeight,maxWidthRatio){
  var heightLimit=Number.isFinite(maxReportedHeight)&&maxReportedHeight>0?Math.max(1,Math.ceil(maxReportedHeight)):${HtmlArtifactDefaults.maxReportedHeight};
  var widthRatioLimit=Number.isFinite(maxWidthRatio)&&maxWidthRatio>0?maxWidthRatio:${HtmlArtifactDefaults.maxWidthRatio};
  var contentFloor=0;
  var feedbackFrozenHeight=0;
  var previousClientHeight=0;
  var previousScrollHeight=0;
  var feedbackSteps=0;
  var hostWidthFloor=0;
  var frozenWidth=0;
  var previousClientWidth=0;
  var previousContentWidth=0;
  var widthFeedbackSteps=0;
  var lastPublishedHeight=0;
  var lastPublishedWidth=0;
  function clampHeight(value){return Math.max(1,Math.min(heightLimit,Math.ceil(Number(value)||1)));}
  function normalizeWidth(value){return Math.max(1,Math.ceil(Number(value)||1));}
  return{
    invalidate:function(){
      contentFloor=0;
      feedbackFrozenHeight=0;
      previousClientHeight=0;
      previousScrollHeight=0;
      feedbackSteps=0;
      previousClientWidth=0;
      previousContentWidth=0;
      widthFeedbackSteps=0;
    },
    resolve:function(measurement){
      var baseHeight=Math.max(1,Math.ceil(Number(measurement.baseHeight)||1));
      var clientHeight=Math.max(0,Math.ceil(Number(measurement.clientHeight)||0));
      var scrollHeight=Math.max(0,Math.ceil(Number(measurement.scrollHeight)||0));
      if(feedbackFrozenHeight)return feedbackFrozenHeight;
      if(scrollHeight>clientHeight+1){
        if(previousClientHeight&&clientHeight>previousClientHeight){
          var clientGrowth=clientHeight-previousClientHeight;
          var contentGrowth=scrollHeight-previousScrollHeight;
          feedbackSteps=contentGrowth>=clientGrowth-1?feedbackSteps+1:0;
        }
        previousClientHeight=clientHeight;
        previousScrollHeight=scrollHeight;
        contentFloor=Math.max(contentFloor,scrollHeight);
        if(feedbackSteps>=2){
          feedbackFrozenHeight=clampHeight(clientHeight);
          return feedbackFrozenHeight;
        }
        return clampHeight(Math.max(baseHeight,scrollHeight));
      }
      previousClientHeight=0;
      previousScrollHeight=0;
      feedbackSteps=0;
      return clampHeight(Math.max(baseHeight,contentFloor));
    },
    resolveWidth:function(measurement){
      var baseWidth=normalizeWidth(measurement.baseWidth);
      var clientWidth=Math.max(0,Math.ceil(Number(measurement.clientWidth)||0));
      if(!hostWidthFloor&&clientWidth)hostWidthFloor=clientWidth;
      if(frozenWidth)return frozenWidth;
      if(baseWidth>clientWidth+1){
        if(previousClientWidth&&clientWidth>previousClientWidth){
          widthFeedbackSteps=baseWidth>previousContentWidth+1?widthFeedbackSteps+1:0;
        }
        previousClientWidth=clientWidth;
        previousContentWidth=baseWidth;
        if(widthFeedbackSteps>=2){
          frozenWidth=normalizeWidth(hostWidthFloor||clientWidth);
          return frozenWidth;
        }
        if(hostWidthFloor&&baseWidth>hostWidthFloor*widthRatioLimit){
          frozenWidth=normalizeWidth(hostWidthFloor*widthRatioLimit);
          return frozenWidth;
        }
        return baseWidth;
      }
      previousClientWidth=0;
      previousContentWidth=0;
      widthFeedbackSteps=0;
      return baseWidth;
    },
    shouldPublish:function(size){
      var height=clampHeight(size.height);
      var width=normalizeWidth(size.width);
      if(Math.abs(height-lastPublishedHeight)<=1&&Math.abs(width-lastPublishedWidth)<=1)return false;
      lastPublishedHeight=height;
      lastPublishedWidth=width;
      return true;
    }
  };
}`
