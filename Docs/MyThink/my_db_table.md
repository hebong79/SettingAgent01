
[목적]
- 셋팅에이전트에서 최종셋업파일을 만들어야 한다. ( 포맷 설정 )
- 프리셋내 주차면들을 만들고 전체 슬롯 인덱스에 매핑한다.
- 카메라, 프리셋 전체를 돌아 번호판 중심으로 센터라이징하고 줌을 하여 PTZ값을 저장한다.

* 주차면 ROI ( 전체 주차면 갯수 만큼 ) 
1. floor_ROI 
 - slot_id			: 전체 슬롯(주차면)id
 - cam_id	   		: 카메라 id	 
 - preset_id   		: 프리셋 id
 - preset_slotidx	: 프리셋내 슬롯순서 
 - slot_roi			: ROI영역 4점 배열
 - pos				: 번호판 중심 센터라이징된 ptz값

* 카메라 정보
3. camera_info
 - cam_id			: 카메라 idx	 
 - cam_name			: 카메라 이름
 - cam_uuid 		: 카메라 UUID
 - url				: 카메라 접속 URL
 - user_id			: 계정 id
 - password			: 접속 password
 - rtsp_url			: rtsp URL
 - cam_type			: Ptz or static
 - cam_company		: 제조회사 ( 휴컴스, 아이디스 등 )
 - place_id			: 장소id - 현재는 무조건 1

* 프리셋 정보
4. preset_info
 - preset_id        : 프리셋 id
 - preset_name      : 프리셋 이름
 - cam_id           : 카메라 id
 - pos              : 프리셋 위치 P,t,z
 - place_id         : 장소 id- 현재는 무조건 1

* 주차장 정보 
4. place_info
 - place_id			: 장소(주차장) id
 - place_name 		: 장소이름

* 센터라이징 (전체 슬롯 갯수만큼만 존재 )
5. slot_setup
 - slot_id		: 슬롯id ( 전체슬롯 기준 )
 - cam_id		: 카메라 id (1부터 시작)
 - preset_id	: 프리셋 id ( 1부터 시작 )
 - preset_slotidx : 프리셋내 슬롯 idx ( 1부터 시작)
 - slot_roi     : 바닥 주차면 ROI
 - slot3d_front_center : 주차면 3D 육면체의 앞면의 중심점( 이미지좌표로 변환된 점)
 - vpd_bbox		: vpd 바운딩 박스
 - lpd_obb		: LPD 번호판 OBB 영역
 - occupy_range	: 점유영역
 - ptz			: 번호판중심 센터라이징 ptz 값
 - img1			: ptz로 이동후 차량 스샷 이미지


** 셋팅에이전트 완성후  카메라 제어 Agent 에서 사용예정 **
* 이벤트 정보 ( 주차면의 주차 상태 이벤트 - 입차/출차 정보 )
6. parking_evnt 
 - slot_id			: 전체슬롯id  
 - is_occupy		: 점유 유무 ( 1: 주차, 0 : 없음 )
 - update_time		: 업데이트 시간 
 - plate_num		: 차량번호 
 - img1				: 차량 이미지  	
 - img2				: 번호판 이미지 ( 크롭 )
 
 * 현재 주차면 상태 ( 전체 슬롯 갯수 만큼만 존재 )
 7. parking_slot 
 - slot_id			: 전체슬롯id  
 - is_occupy		: 점유 유무 ( 1: 주차, 0 : 없음 )
 - update_time		: 업데이트 시간 
 - plate_num		: 차량번호 
 - img1				: 차량 이미지  	
 - img2				: 번호판 이미지 ( 크롭 )
 

 
 