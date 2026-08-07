/**
 * Self-contained factory injected into generated iframe documents. Keeping the executable source as
 * an explicit string makes production bundling deterministic; tests execute this exact same source.
 *
 * The controller owns both axes of the size the iframe reports to its host, because both axes are
 * fed back into the iframe by the host (height becomes the frame height, width becomes the frame
 * width plus a scale factor). Any measurement that is itself a function of the viewport therefore
 * closes a loop, and the loop has to be broken here — the host cannot tell a runaway apart from a
 * genuinely growing document.
 *
 * - Height: overflow-time `scrollHeight` is a monotone floor, two viewport-tracking growth steps
 *   freeze the report at the current client height, and `maxReportedHeight` is a hard cap.
 * - Width: `100vw` children, percentage-positioned decorations and anything clipped by an ancestor
 *   all make the measured content width grow whenever the host widens the frame. Two growth steps
 *   freeze the report at the first host width; `maxWidthRatio` is the hard cap. The width freeze is
 *   sticky across `invalidate()` — a document whose width tracks the viewport does not stop doing so
 *   because a patch changed its DOM, and un-freezing on every mutation would restart the runaway.
 */
export const HTML_ARTIFACT_SIZE_CONTROLLER_FACTORY_SOURCE = `function(maxReportedHeight,maxWidthRatio){
  var heightLimit=Number.isFinite(maxReportedHeight)&&maxReportedHeight>0?Math.max(1,Math.ceil(maxReportedHeight)):1200;
  var widthRatioLimit=Number.isFinite(maxWidthRatio)&&maxWidthRatio>0?maxWidthRatio:3;
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
