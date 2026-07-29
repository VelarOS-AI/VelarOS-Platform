/**
 * Self-contained factory injected into generated iframe documents. Keeping the executable source as
 * an explicit string makes production bundling deterministic; tests execute this exact same source.
 */
export const HTML_ARTIFACT_HEIGHT_CONTROLLER_FACTORY_SOURCE = `function(maxReportedHeight){
  var heightLimit=Number.isFinite(maxReportedHeight)&&maxReportedHeight>0?Math.max(1,Math.ceil(maxReportedHeight)):1200;
  var contentFloor=0;
  var feedbackFrozenHeight=0;
  var previousClientHeight=0;
  var previousScrollHeight=0;
  var feedbackSteps=0;
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
