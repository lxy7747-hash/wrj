/**
 * 对接示例 ad_hoc_comm.txt 内容（2026-11-01 版模板）：自组网网络、AD_HOC 收发器、连线绘制脚本、
 * 自组网路由协议与 DEFAULT 路由器，均为固定值，界面没有对应参数。
 * 除首行 Wizard 生成戳注释外与模板逐行一致；该戳不适用于本生成包，且会触发服务端源码边界检查。
 * 示例 comm_SimSetup.txt 未 include 该文件，生成包同样只随包输出、不在入口引用。
 */
export const AD_HOC_COMM_FILE = 'ad_hoc_comm.txt'

export const AD_HOC_COMM_TEXT = `#network ad_hoc WSF_COMM_NETWORK_AD_HOC
network ad_hoc WSF_COMM_NETWORK_AD_HOC
   #update_rate normal mean 5.0 s sigma 0.25 s
   update_rate 5 sec
end_network

network ad_hoc1 WSF_COMM_NETWORK_AD_HOC
   #update_rate normal mean 5.0 s sigma 0.25 s
   update_rate 5 sec
end_network

comm AD_HOC WSF_RADIO_TRANSCEIVER
   network_name ad_hoc
   transmitter
      frequency 100 mhz
      power 50 mw
      maximum_range 100 km
   end_transmitter
   
   receiver
      frequency 100 mhz
   end_receiver
end_comm


script_variables
   WsfDraw draw = WsfDraw();
end_script_variables

script void DrawConnection(WsfAddress aSourceAddress, WsfAddress aDestinationAddress)

   WsfPlatform sourcePlat = WsfComm.GetComm(aSourceAddress).Platform();
   WsfPlatform destinationPlat = WsfComm.GetComm(aDestinationAddress).Platform();
   
   draw.SetId(aSourceAddress.GetAddress() + aDestinationAddress.GetAddress());
   draw.SetLineStyle("dotted");
   
   draw.BeginLines();
      draw.SetDuration(Math.DOUBLE_MAX());
      draw.SetLineSize(2);
      draw.SetColor(1.0, 1.0, 1.0);
      draw.Vertex(sourcePlat);
      draw.Vertex(destinationPlat);
   draw.End();
    
end_script

script void EraseDrawConnection(WsfAddress aSourceAddress, WsfAddress aDestionationAddress)
   draw.Erase(aSourceAddress.GetAddress()+aDestionationAddress.GetAddress());
end_script

script void DrawRouting(WsfAddress aSourceAddress, WsfAddress aDestinationAddress)

   WsfPlatform sourcePlat = WsfComm.GetComm(aSourceAddress).Platform();
   WsfPlatform destinationPlat= WsfComm.GetComm(aDestinationAddress).Platform();
   
   draw.SetLineStyle("solid");
   draw.BeginLines();
      draw.SetDuration(2.0);
      draw.SetLineSize(4.0);
      draw.SetColor(1.0, 0.0, 0.0);
      draw.Vertex(sourcePlat);
      draw.Vertex(destinationPlat);
   draw.End();
end_script

router_protocol AD_HOC WSF_COMM_ROUTER_PROTOCOL_AD_HOC

   comm_added_delay_time 0.5 sec
   comm_removed_delay_time 0.5 sec
   connection_added_delay_time 5.0 sec    #         5s
   connection_removed_delay_time 0.5 sec

   script bool OnCommAdded(WsfAddress aAddress, WsfCommGraph aGraph, WsfCommRouter aRouter)
      return true;
   end_script

   script bool OnCommRemoved(WsfAddress aAddress, WsfCommGraph aGraph, WsfCommRouter aRouter)
      return true;
   end_script
   
   script bool OnConnectionAdded(WsfAddress aSourceAddress, WsfAddress aDestinationAddress, WsfCommGraph aGraph, WsfCommRouter aRouter)
      DrawConnection(aSourceAddress, aDestinationAddress);
      return true;
   end_script

   script bool OnConnectionRemoved(WsfAddress aSourceAddress, WsfAddress aDestinationAddress, WsfCommGraph aGraph, WsfCommRouter aRouter)
      EraseDrawConnection(aSourceAddress, aDestinationAddress);
      return true;
   end_script
   
   script WsfAddress OnMessageRouting(WsfCommMessage aMessage, WsfAddress aAddress, WsfCommGraph aGraph, WsfCommRouter aRouter)
   
      Array<WsfCommGraphEdge> edges = aGraph.GetOutgoingNodeEdges(aAddress);
      WsfComm destinationComm = WsfComm.GetComm(aMessage.GetSourceMessage().Destination());
      WsfGeoPoint destLoc = destinationComm.Platform().Location();
      WsfAddress hop = {};
      double totalDistance = MATH.DOUBLE_MAX();
      Array<WsfAddress> traceRoute = aMessage.GetTraceRoute();
      foreach(WsfCommGraphEdge edge in edges)
      {
         if(edge.DestinationAddress().GetAddress() == aAddress.GetAddress())
         {
            continue;
         }
         
         foreach(WsfAddress visited in traceRoute)
         {
            if(visited.GetAddress() == edge.DestinationAddress().GetAddress())
            {
               continue;
            }
         }
         
         WsfComm potentialComm = WsfComm.GetComm(edge.DestinationAddress());
         double distance = destLoc.GroundRangeTo(potentialComm.Platform().Location());
         if(distance < totalDistance)
         {
            totalDistance = distance;
            hop = edge.DestinationAddress();
         }
      }
      
      if(!hop.IsNull())
      {
         DrawRouting(aAddress, hop);
      }
      
      return hop;
   
   end_script
   
end_router_protocol

router DEFAULT WSF_COMM_ROUTER
   add router_protocol ad_hoc AD_HOC end_router_protocol
   use_default_protocol false
   hop_limit 5
end_router
`
