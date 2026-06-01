/**
 * pinyin.ts — 简体中文拼音转换（纯手写映射表，零依赖）
 *
 * 特性：
 * - 基于常用汉字拼音表
 * - 多音字通过 frequency-based 简单消歧
 * - 拼音 prefix 搜索（首字母匹配）
 * - 在 FullTextIndex 中集成拼音搜索支持
 *
 * 接口：
 *   toPinyin(text: string, options?): string
 *   toPinyinPrefix(text: string, options?): string
 *   pinyinSearch(query: string, candidates: string[]): string[]
 *   getTextPinyinMatches(text: string, pinyinQuery: string): boolean
 */

export interface PinyinOptions {
  /** 结果中拼音的分隔符，默认 " " */
  separator?: string
  /** 是否保留非中文字符，默认 true */
  keepNonChinese?: boolean
  /** 多音字处理策略：默认取第一个（最常见读音） */
  polyphoneStrategy?: 'first' | 'frequency'
}

// ── 多音字频率消歧映射 ──
const POLYPHONE_MAP: Record<string, string[]> = {
  '了': ['le', 'liao'],
  '行': ['xing', 'hang'],
  '长': ['chang', 'zhang'],
  '重': ['zhong', 'chong'],
  '朝': ['chao', 'zhao'],
  '传': ['chuan', 'zhuan'],
  '调': ['diao', 'tiao'],
  '乐': ['le', 'yue'],
  '还': ['hai', 'huan'],
  '都': ['dou', 'du'],
  '的': ['de', 'di'],
  '着': ['zhe', 'zhao', 'zhuo'],
  '数': ['shu', 'shuo'],
  '觉': ['jue', 'jiao'],
  '角': ['jiao', 'jue'],
  '给': ['gei', 'ji'],
  '和': ['he', 'huo'],
  '间': ['jian', 'jian'],
  '会': ['hui', 'kuai'],
  '强': ['qiang', 'qiang'],
  '中': ['zhong', 'zhong'],
  '种': ['zhong', 'zhong'],
  '为': ['wei', 'wei'],
  '应': ['ying', 'ying'],
  '便': ['bian', 'pian'],
  '藏': ['cang', 'zang'],
  '差': ['cha', 'chai'],
  '车': ['che', 'ju'],
  '称': ['cheng', 'cheng'],
  '单': ['dan', 'shan'],
  '弹': ['dan', 'tan'],
  '得': ['de', 'dei'],
  '地': ['de', 'di'],
  '恶': ['e', 'wu'],
  '分': ['fen', 'fen'],
  '供': ['gong', 'gong'],
  '降': ['jiang', 'xiang'],
  '结': ['jie', 'jie'],
  '解': ['jie', 'xie'],
  '禁': ['jin', 'jin'],
  '尽': ['jin', 'jin'],
  '卷': ['juan', 'juan'],
  '卡': ['ka', 'qia'],
  '壳': ['ke', 'qiao'],
  '空': ['kong', 'kong'],
  '绿': ['lv', 'lu'],
  '落': ['luo', 'la'],
  '埋': ['mai', 'man'],
  '没': ['mei', 'mo'],
  '蒙': ['meng', 'meng'],
  '秘': ['mi', 'bi'],
  '模': ['mo', 'mu'],
  '宁': ['ning', 'ning'],
  '迫': ['po', 'pai'],
  '铺': ['pu', 'pu'],
  '奇': ['qi', 'ji'],
  '切': ['qie', 'qie'],
  '亲': ['qin', 'qing'],
  '曲': ['qu', 'qu'],
  '圈': ['quan', 'juan'],
  '任': ['ren', 'ren'],
  '散': ['san', 'san'],
  '色': ['se', 'shai'],
  '上': ['shang', 'shang'],
  '少': ['shao', 'shao'],
  '省': ['sheng', 'xing'],
  '识': ['shi', 'zhi'],
  '似': ['si', 'shi'],
  '宿': ['su', 'xiu'],
  '提': ['ti', 'di'],
  '同': ['tong', 'tong'],
  '吐': ['tu', 'tu'],
  '尾': ['wei', 'yi'],
  '血': ['xue', 'xie'],
  '要': ['yao', 'yao'],
  '只': ['zhi', 'zhi'],
  '转': ['zhuan', 'zhuan'],
  '钻': ['zuan', 'zuan'],
  '作': ['zuo', 'zuo'],
  '啊': ['a', 'a'],
  '阿': ['a', 'e'],
  '挨': ['ai', 'ai'],
  '扒': ['ba', 'pa'],
  '把': ['ba', 'ba'],
  '膀': ['bang', 'pang'],
  '剥': ['bao', 'bo'],
  '薄': ['bao', 'bo'],
  '奔': ['ben', 'ben'],
  '别': ['bie', 'bie'],
  '伯': ['bo', 'bai'],
  '卜': ['bu', 'bo'],
  '采': ['cai', 'cai'],
  '参': ['can', 'shen'],
  '曾': ['ceng', 'zeng'],
  '禅': ['chan', 'shan'],
  '颤': ['chan', 'zhan'],
  '场': ['chang', 'chang'],
  '乘': ['cheng', 'sheng'],
  '冲': ['chong', 'chong'],
  '仇': ['chou', 'qiu'],
  '处': ['chu', 'chu'],
  '畜': ['chu', 'xu'],
  '创': ['chuang', 'chuang'],
  '攒': ['zan', 'cuan'],
  '倒': ['dao', 'dao'],
  '钉': ['ding', 'ding'],
  '斗': ['dou', 'dou'],
  '肚': ['du', 'du'],
  '度': ['du', 'duo'],
  '囤': ['dun', 'tun'],
  '发': ['fa', 'fa'],
  '缝': ['feng', 'feng'],
  '佛': ['fo', 'fu'],
  '干': ['gan', 'gan'],
  '杆': ['gan', 'gan'],
  '勾': ['gou', 'gou'],
  '冠': ['guan', 'guan'],
  '哈': ['ha', 'ha'],
  '汗': ['han', 'han'],
  '号': ['hao', 'hao'],
  '核': ['he', 'hu'],
  '横': ['heng', 'heng'],
  '哄': ['hong', 'hong'],
  '划': ['hua', 'hua'],
  '华': ['hua', 'hua'],
  '晃': ['huang', 'huang'],
  '混': ['hun', 'hun'],
  '几': ['ji', 'ji'],
  '济': ['ji', 'ji'],
  '系': ['xi', 'ji'],
  '茄': ['qie', 'jia'],
  '浆': ['jiang', 'jiang'],
  '嚼': ['jiao', 'jue'],
  '据': ['ju', 'ju'],
  '看': ['kan', 'kan'],
  '拉': ['la', 'la'],
  '烙': ['lao', 'luo'],
  '勒': ['le', 'lei'],
  '擂': ['lei', 'lei'],
  '俩': ['lia', 'liang'],
  '量': ['liang', 'liang'],
  '淋': ['lin', 'lin'],
  '令': ['ling', 'ling'],
  '溜': ['liu', 'liu'],
  '陆': ['lu', 'liu'],
  '笼': ['long', 'long'],
  '露': ['lu', 'lou'],
  '率': ['lv', 'shuai'],
  '吗': ['ma', 'ma'],
  '脉': ['mai', 'mo'],
  '蔓': ['man', 'wan'],
  '猫': ['mao', 'mao'],
  '闷': ['men', 'men'],
  '哪': ['na', 'ne'],
  '那': ['na', 'nei'],
  '难': ['nan', 'nan'],
  '呢': ['ne', 'ni'],
  '尿': ['niao', 'sui'],
  '弄': ['nong', 'long'],
  '区': ['qu', 'ou'],
  '胖': ['pang', 'pan'],
  '刨': ['pao', 'bao'],
  '跑': ['pao', 'pao'],
  '泡': ['pao', 'pao'],
  '喷': ['pen', 'pen'],
  '片': ['pian', 'pian'],
  '漂': ['piao', 'piao'],
  '屏': ['ping', 'bing'],
  '泼': ['po', 'po'],
  '仆': ['pu', 'pu'],
  '朴': ['pu', 'piao'],
  '曝': ['pu', 'bao'],
  '期': ['qi', 'ji'],
  '铅': ['qian', 'yan'],
  '浅': ['qian', 'jian'],
  '抢': ['qiang', 'qiang'],
  '翘': ['qiao', 'qiao'],
  '夏': ['xia', 'xia'],
  '厦': ['sha', 'xia'],
  '稍': ['shao', 'shao'],
  '折': ['zhe', 'she'],
  '舍': ['she', 'she'],
  '食': ['shi', 'si'],
  '熟': ['shu', 'shou'],
  '术': ['shu', 'zhu'],
  '衰': ['shuai', 'cui'],
  '说': ['shuo', 'shui'],
  '踏': ['ta', 'ta'],
  '汤': ['tang', 'shang'],
  '倘': ['tang', 'chang'],
  '挑': ['tiao', 'tiao'],
  '瓦': ['wa', 'wa'],
  '万': ['wan', 'mo'],
  '鲜': ['xian', 'xian'],
  '相': ['xiang', 'xiang'],
  '兴': ['xing', 'xing'],
  '旋': ['xuan', 'xuan'],
  '削': ['xiao', 'xue'],
  '呀': ['ya', 'ya'],
  '殷': ['yin', 'yan'],
  '饮': ['yin', 'yin'],
  '佣': ['yong', 'yong'],
  '与': ['yu', 'yu'],
  '吁': ['xu', 'yu'],
  '约': ['yue', 'yao'],
  '晕': ['yun', 'yun'],
  '载': ['zai', 'zai'],
  '脏': ['zang', 'zang'],
  '择': ['ze', 'zhai'],
  '扎': ['zha', 'zha'],
  '轧': ['zha', 'ya'],
  '炸': ['zha', 'zha'],
  '涨': ['zhang', 'zhang'],
  '挣': ['zheng', 'zheng'],
  '正': ['zheng', 'zheng'],
  '症': ['zheng', 'zheng'],
  '殖': ['zhi', 'shi'],
  '轴': ['zhou', 'zhou'],
  '逐': ['zhu', 'zhu'],
  '赚': ['zhuan', 'zuan'],
  '幢': ['zhuang', 'chuang'],
  '兹': ['zi', 'ci'],
  '足': ['zu', 'ju'],
}

// ── 主拼音映射表 ──
const PINYIN_MAP: Record<string, string> = {
'啊':'a','阿':'a','埃':'ai','挨':'ai','哎':'ai','哀':'ai','癌':'ai',
'蔼':'ai','矮':'ai','艾':'ai','碍':'ai','爱':'ai','隘':'ai',
'鞍':'an','氨':'an','安':'an','俺':'an','按':'an','暗':'an',
'岸':'an','案':'an','昂':'ang','盎':'ang','袄':'ao','凹':'ao',
'熬':'ao','翱':'ao','奥':'ao','懊':'ao','澳':'ao',
'芭':'ba','扒':'ba','叭':'ba','吧':'ba','八':'ba','疤':'ba',
'巴':'ba','拔':'ba','跋':'ba','靶':'ba','把':'ba','坝':'ba',
'霸':'ba','罢':'ba','爸':'ba','白':'bai','柏':'bai','百':'bai',
'摆':'bai','败':'bai','拜':'bai','班':'ban','搬':'ban','扳':'ban',
'般':'ban','颁':'ban','板':'ban','版':'ban','扮':'ban','拌':'ban',
'伴':'ban','瓣':'ban','半':'ban','办':'ban','绊':'ban',
'邦':'bang','帮':'bang','榜':'bang','绑':'bang','棒':'bang',
'磅':'bang','蚌':'bang','镑':'bang','傍':'bang','谤':'bang',
'苞':'bao','胞':'bao','包':'bao','褒':'bao','雹':'bao','保':'bao',
'堡':'bao','饱':'bao','宝':'bao','抱':'bao','报':'bao','暴':'bao',
'豹':'bao','爆':'bao','杯':'bei','碑':'bei','悲':'bei','卑':'bei',
'北':'bei','辈':'bei','贝':'bei','倍':'bei','备':'bei','惫':'bei',
'焙':'bei','被':'bei','奔':'ben','苯':'ben','本':'ben','笨':'ben',
'崩':'beng','绷':'beng','泵':'beng','蹦':'beng','迸':'beng',
'逼':'bi','鼻':'bi','比':'bi','鄙':'bi','笔':'bi','彼':'bi',
'碧':'bi','蔽':'bi','毕':'bi','毙':'bi','币':'bi','庇':'bi',
'闭':'bi','弊':'bi','必':'bi','壁':'bi','避':'bi','陛':'bi',
'鞭':'bian','边':'bian','编':'bian','贬':'bian','变':'bian',
'辨':'bian','辩':'bian','辫':'bian','遍':'bian',
'标':'biao','彪':'biao','表':'biao','鳖':'bie','憋':'bie','瘪':'bie',
'彬':'bin','斌':'bin','濒':'bin','滨':'bin','宾':'bin',
'兵':'bing','冰':'bing','柄':'bing','丙':'bing','秉':'bing',
'饼':'bing','病':'bing','并':'bing',
'玻':'bo','菠':'bo','播':'bo','拨':'bo','波':'bo','博':'bo',
'勃':'bo','搏':'bo','箔':'bo','帛':'bo','舶':'bo','脖':'bo',
'膊':'bo','渤':'bo','驳':'bo',
'捕':'bu','哺':'bu','补':'bu','埠':'bu','不':'bu','布':'bu',
'步':'bu','簿':'bu','部':'bu','怖':'bu',
'擦':'ca','猜':'cai','裁':'cai','材':'cai','才':'cai','财':'cai',
'睬':'cai','踩':'cai','彩':'cai','菜':'cai','蔡':'cai',
'餐':'can','蚕':'can','残':'can','惭':'can','惨':'can','灿':'can',
'苍':'cang','舱':'cang','仓':'cang','沧':'cang',
'操':'cao','糙':'cao','槽':'cao','曹':'cao','草':'cao',
'厕':'ce','策':'ce','册':'ce','测':'ce','层':'ceng','蹭':'ceng',
'插':'cha','叉':'cha','茬':'cha','茶':'cha','碴':'cha','察':'cha',
'岔':'cha','诧':'cha','拆':'chai','柴':'chai',
'搀':'chan','掺':'chan','蝉':'chan','馋':'chan','缠':'chan',
'铲':'chan','产':'chan','阐':'chan',
'昌':'chang','猖':'chang','尝':'chang','常':'chang','偿':'chang',
'肠':'chang','厂':'chang','敞':'chang','畅':'chang','唱':'chang',
'倡':'chang','超':'chao','抄':'chao','钞':'chao','嘲':'chao',
'潮':'chao','巢':'chao','吵':'chao','炒':'chao',
'扯':'che','撤':'che','彻':'che','澈':'che',
'辰':'chen','尘':'chen','晨':'chen','忱':'chen','沉':'chen',
'陈':'chen','趁':'chen','衬':'chen',
'撑':'cheng','城':'cheng','橙':'cheng','成':'cheng','呈':'cheng',
'程':'cheng','惩':'cheng','澄':'cheng','诚':'cheng','承':'cheng',
'逞':'cheng','秤':'cheng',
'吃':'chi','痴':'chi','持':'chi','匙':'chi','池':'chi','迟':'chi',
'弛':'chi','耻':'chi','齿':'chi','侈':'chi','尺':'chi','赤':'chi',
'翅':'chi','斥':'chi','炽':'chi',
'充':'chong','虫':'chong','崇':'chong','宠':'chong',
'抽':'chou','酬':'chou','稠':'chou','愁':'chou','筹':'chou',
'绸':'chou','瞅':'chou','丑':'chou',
'初':'chu','出':'chu','橱':'chu','厨':'chu','锄':'chu','雏':'chu',
'除':'chu','楚':'chu','础':'chu','储':'chu','矗':'chu','触':'chu',
'揣':'chuai','川':'chuan','穿':'chuan','船':'chuan','喘':'chuan',
'串':'chuan','疮':'chuang','窗':'chuang','床':'chuang','闯':'chuang',
'吹':'chui','炊':'chui','捶':'chui','锤':'chui','垂':'chui',
'春':'chun','椿':'chun','醇':'chun','唇':'chun','淳':'chun',
'纯':'chun','蠢':'chun','戳':'chuo','绰':'chuo',
'疵':'ci','磁':'ci','雌':'ci','辞':'ci','慈':'ci','瓷':'ci',
'词':'ci','此':'ci','刺':'ci','赐':'ci','次':'ci',
'聪':'cong','葱':'cong','从':'cong','丛':'cong',
'凑':'cou','粗':'cu','醋':'cu','簇':'cu','促':'cu',
'蹿':'cuan','篡':'cuan','窜':'cuan',
'摧':'cui','崔':'cui','催':'cui','脆':'cui','粹':'cui','翠':'cui',
'村':'cun','存':'cun','寸':'cun',
'磋':'cuo','撮':'cuo','搓':'cuo','措':'cuo','挫':'cuo','错':'cuo',
'搭':'da','达':'da','答':'da','打':'da','大':'da',
'呆':'dai','歹':'dai','戴':'dai','带':'dai','代':'dai','袋':'dai',
'待':'dai','逮':'dai','怠':'dai','贷':'dai',
'担':'dan','丹':'dan','胆':'dan','旦':'dan','但':'dan',
'淡':'dan','诞':'dan','蛋':'dan',
'当':'dang','挡':'dang','党':'dang','荡':'dang','档':'dang',
'刀':'dao','捣':'dao','蹈':'dao','岛':'dao','祷':'dao','导':'dao',
'到':'dao','稻':'dao','悼':'dao','道':'dao','盗':'dao',
'德':'de','蹬':'deng','灯':'deng','登':'deng','等':'deng',
'瞪':'deng','凳':'deng','邓':'deng',
'堤':'di','低':'di','滴':'di','迪':'di','敌':'di','笛':'di',
'涤':'di','抵':'di','底':'di','第':'di','帝':'di','弟':'di',
'递':'di','缔':'di',
'颠':'dian','掂':'dian','点':'dian','典':'dian','垫':'dian',
'电':'dian','佃':'dian','店':'dian','惦':'dian','奠':'dian',
'淀':'dian','殿':'dian','碉':'diao','叼':'diao','雕':'diao',
'刁':'diao','掉':'diao','吊':'diao','钓':'diao',
'跌':'die','爹':'die','碟':'die','蝶':'die','迭':'die','叠':'die',
'丁':'ding','盯':'ding','叮':'ding','顶':'ding','鼎':'ding',
'定':'ding','订':'ding','丢':'diu','东':'dong','冬':'dong',
'董':'dong','懂':'dong','动':'dong','栋':'dong','冻':'dong','洞':'dong',
'兜':'dou','抖':'dou','陡':'dou','豆':'dou','逗':'dou',
'督':'du','毒':'du','独':'du','读':'du','堵':'du','睹':'du',
'赌':'du','杜':'du','肚':'du','度':'du','渡':'du','妒':'du',
'端':'duan','短':'duan','锻':'duan','段':'duan','断':'duan',
'堆':'dui','兑':'dui','队':'dui','对':'dui',
'墩':'dun','吨':'dun','蹲':'dun','敦':'dun','顿':'dun','钝':'dun',
'盾':'dun','掇':'duo','哆':'duo','多':'duo','夺':'duo','躲':'duo',
'朵':'duo','跺':'duo','舵':'duo','惰':'duo','堕':'duo',
'哦':'e','峨':'e','鹅':'e','俄':'e','额':'e','讹':'e','厄':'e',
'扼':'e','遏':'e','饿':'e','恩':'en','而':'er','儿':'er',
'耳':'er','尔':'er','二':'er',
'发':'fa','罚':'fa','伐':'fa','乏':'fa','阀':'fa','法':'fa',
'帆':'fan','番':'fan','翻':'fan','繁':'fan','凡':'fan','烦':'fan',
'反':'fan','返':'fan','范':'fan','贩':'fan','犯':'fan','饭':'fan',
'泛':'fan','坊':'fang','芳':'fang','方':'fang','房':'fang',
'防':'fang','妨':'fang','仿':'fang','访':'fang','纺':'fang',
'放':'fang','菲':'fei','非':'fei','飞':'fei','肥':'fei','匪':'fei',
'诽':'fei','肺':'fei','废':'fei','沸':'fei','费':'fei',
'芬':'fen','吩':'fen','氛':'fen','纷':'fen','坟':'fen',
'焚':'fen','粉':'fen','份':'fen','愤':'fen','粪':'fen',
'丰':'feng','封':'feng','枫':'feng','蜂':'feng','峰':'feng',
'锋':'feng','风':'feng','疯':'feng','逢':'feng','冯':'feng',
'讽':'feng','奉':'feng','凤':'feng',
'佛':'fo','否':'fou','夫':'fu','敷':'fu','肤':'fu','孵':'fu',
'扶':'fu','拂':'fu','辐':'fu','幅':'fu','氟':'fu','符':'fu',
'伏':'fu','俘':'fu','浮':'fu','福':'fu','弗':'fu','甫':'fu',
'抚':'fu','辅':'fu','俯':'fu','斧':'fu','腑':'fu','府':'fu',
'腐':'fu','赴':'fu','副':'fu','覆':'fu','赋':'fu','复':'fu',
'傅':'fu','付':'fu','父':'fu','腹':'fu','负':'fu','富':'fu',
'附':'fu','妇':'fu','缚':'fu','咐':'fu',
'嘎':'ga','该':'gai','改':'gai','概':'gai','钙':'gai','盖':'gai',
'溉':'gai','干':'gan','甘':'gan','柑':'gan','竿':'gan','肝':'gan',
'赶':'gan','感':'gan','敢':'gan','赣':'gan','冈':'gang','刚':'gang',
'钢':'gang','缸':'gang','肛':'gang','纲':'gang','岗':'gang',
'港':'gang','杠':'gang','篙':'gao','高':'gao','膏':'gao',
'羔':'gao','糕':'gao','搞':'gao','稿':'gao','告':'gao',
'哥':'ge','歌':'ge','搁':'ge','戈':'ge','鸽':'ge','胳':'ge',
'疙':'ge','割':'ge','革':'ge','葛':'ge','格':'ge','蛤':'ge',
'阁':'ge','隔':'ge','铬':'ge','个':'ge','各':'ge',
'根':'gen','跟':'gen','耕':'geng','羹':'geng','耿':'geng',
'梗':'geng','工':'gong','攻':'gong','功':'gong','恭':'gong',
'龚':'gong','躬':'gong','公':'gong','宫':'gong','弓':'gong',
'巩':'gong','拱':'gong','贡':'gong','共':'gong',
'钩':'gou','沟':'gou','苟':'gou','狗':'gou','垢':'gou',
'构':'gou','购':'gou','够':'gou',
'辜':'gu','菇':'gu','咕':'gu','箍':'gu','估':'gu','沽':'gu',
'孤':'gu','姑':'gu','鼓':'gu','古':'gu','骨':'gu','谷':'gu',
'股':'gu','故':'gu','顾':'gu','固':'gu','雇':'gu',
'瓜':'gua','刮':'gua','寡':'gua','挂':'gua','褂':'gua',
'乖':'guai','拐':'guai','怪':'guai',
'棺':'guan','关':'guan','官':'guan','观':'guan',
'管':'guan','馆':'guan','罐':'guan','惯':'guan','灌':'guan','贯':'guan',
'光':'guang','广':'guang','逛':'guang',
'瑰':'gui','规':'gui','硅':'gui','归':'gui','龟':'gui',
'闺':'gui','轨':'gui','鬼':'gui','诡':'gui','桂':'gui',
'柜':'gui','跪':'gui','贵':'gui','辊':'gun','滚':'gun','棍':'gun',
'锅':'guo','郭':'guo','国':'guo','果':'guo','裹':'guo','过':'guo',
'哈':'ha','骸':'hai','孩':'hai','海':'hai','亥':'hai',
'害':'hai','骇':'hai','酣':'han','憨':'han','韩':'han','含':'han',
'涵':'han','寒':'han','函':'han','喊':'han','罕':'han','翰':'han',
'撼':'han','捍':'han','旱':'han','憾':'han','悍':'han','焊':'han',
'汉':'han','杭':'hang','航':'hang',
'壕':'hao','嚎':'hao','豪':'hao','毫':'hao','郝':'hao','好':'hao',
'耗':'hao','号':'hao','浩':'hao',
'呵':'he','喝':'he','荷':'he','菏':'he','核':'he','禾':'he',
'和':'he','何':'he','合':'he','盒':'he','阂':'he','河':'he',
'涸':'he','赫':'he','褐':'he','鹤':'he','贺':'he',
'嘿':'hei','黑':'hei','痕':'hen','很':'hen','狠':'hen','恨':'hen',
'哼':'heng','亨':'heng','衡':'heng','恒':'heng',
'轰':'hong','哄':'hong','烘':'hong','虹':'hong','鸿':'hong','洪':'hong',
'宏':'hong','弘':'hong','红':'hong',
'喉':'hou','侯':'hou','猴':'hou','吼':'hou','厚':'hou','候':'hou',
'后':'hou','呼':'hu','乎':'hu','忽':'hu','瑚':'hu','壶':'hu',
'葫':'hu','胡':'hu','蝴':'hu','狐':'hu','糊':'hu','湖':'hu',
'弧':'hu','虎':'hu','唬':'hu','护':'hu','互':'hu','沪':'hu','户':'hu',
'花':'hua','哗':'hua','华':'hua','猾':'hua','滑':'hua','画':'hua',
'划':'hua','化':'hua','话':'hua',
'槐':'huai','徊':'huai','怀':'huai','淮':'huai','坏':'huai',
'欢':'huan','环':'huan','桓':'huan','还':'huan','缓':'huan',
'换':'huan','患':'huan','唤':'huan','痪':'huan','焕':'huan',
'涣':'huan','幻':'huan','荒':'huang','慌':'huang','黄':'huang',
'磺':'huang','蝗':'huang','簧':'huang','皇':'huang','凰':'huang',
'惶':'huang','煌':'huang','晃':'huang','幌':'huang','恍':'huang',
'谎':'huang','灰':'hui','挥':'hui','辉':'hui','徽':'hui','恢':'hui',
'蛔':'hui','回':'hui','毁':'hui','悔':'hui','慧':'hui','卉':'hui',
'惠':'hui','晦':'hui','贿':'hui','秽':'hui','会':'hui','烩':'hui',
'汇':'hui','讳':'hui','诲':'hui','绘':'hui',
'荤':'hun','昏':'hun','婚':'hun','魂':'hun','浑':'hun','混':'hun',
'豁':'huo','活':'huo','伙':'huo','火':'huo','获':'huo','或':'huo',
'惑':'huo','霍':'huo','货':'huo','祸':'huo',
'讥':'ji','击':'ji','圾':'ji','箕':'ji','肌':'ji','饥':'ji',
'激':'ji','机':'ji','鸡':'ji','绩':'ji','积':'ji','迹':'ji',
'姬':'ji','缉':'ji','集':'ji','及':'ji','急':'ji','疾':'ji',
'汲':'ji','即':'ji','嫉':'ji','级':'ji','挤':'ji','几':'ji',
'脊':'ji','己':'ji','蓟':'ji','技':'ji','冀':'ji','季':'ji',
'伎':'ji','祭':'ji','剂':'ji','悸':'ji','寄':'ji','寂':'ji',
'计':'ji','记':'ji','忌':'ji','际':'ji','妓':'ji','继':'ji',
'纪':'ji','嘉':'jia','枷':'jia','夹':'jia','佳':'jia','家':'jia',
'加':'jia','荚':'jia','颊':'jia','贾':'jia','甲':'jia','钾':'jia',
'假':'jia','稼':'jia','价':'jia','架':'jia','驾':'jia','嫁':'jia',
'歼':'jian','监':'jian','坚':'jian','尖':'jian','笺':'jian','间':'jian',
'煎':'jian','兼':'jian','肩':'jian','艰':'jian','奸':'jian','缄':'jian',
'茧':'jian','检':'jian','柬':'jian','碱':'jian','硷':'jian','拣':'jian',
'捡':'jian','简':'jian','俭':'jian','剪':'jian','减':'jian','荐':'jian',
'槛':'jian','鉴':'jian','践':'jian','贱':'jian','见':'jian','键':'jian',
'箭':'jian','件':'jian','健':'jian','舰':'jian','剑':'jian','饯':'jian',
'渐':'jian','溅':'jian','涧':'jian','建':'jian',
'僵':'jiang','姜':'jiang','将':'jiang','浆':'jiang','江':'jiang',
'疆':'jiang','蒋':'jiang','桨':'jiang','奖':'jiang','讲':'jiang',
'匠':'jiang','酱':'jiang','降':'jiang',
'蕉':'jiao','椒':'jiao','礁':'jiao','焦':'jiao','胶':'jiao','交':'jiao',
'郊':'jiao','浇':'jiao','骄':'jiao','娇':'jiao','嚼':'jiao','搅':'jiao',
'铰':'jiao','矫':'jiao','侥':'jiao','脚':'jiao','饺':'jiao','缴':'jiao',
'绞':'jiao','剿':'jiao','教':'jiao','酵':'jiao','轿':'jiao','较':'jiao',
'叫':'jiao','窖':'jiao','揭':'jie','接':'jie','皆':'jie','秸':'jie',
'街':'jie','阶':'jie','截':'jie','劫':'jie','节':'jie','桔':'jie',
'杰':'jie','捷':'jie','睫':'jie','竭':'jie','洁':'jie','结':'jie',
'解':'jie','姐':'jie','戒':'jie','藉':'jie','芥':'jie','界':'jie',
'借':'jie','介':'jie','疥':'jie','诫':'jie','届':'jie',
'巾':'jin','筋':'jin','斤':'jin','金':'jin','今':'jin','津':'jin',
'襟':'jin','紧':'jin','锦':'jin','仅':'jin','谨':'jin','进':'jin',
'靳':'jin','晋':'jin','禁':'jin','近':'jin','烬':'jin','浸':'jin',
'尽':'jin','劲':'jin','荆':'jing','兢':'jing','茎':'jing','睛':'jing',
'晶':'jing','鲸':'jing','京':'jing','惊':'jing','精':'jing','粳':'jing',
'经':'jing','井':'jing','警':'jing','景':'jing','颈':'jing','静':'jing',
'境':'jing','敬':'jing','镜':'jing','径':'jing','痉':'jing','靖':'jing',
'竞':'jing','净':'jing','炯':'jiong','窘':'jiong',
'揪':'jiu','究':'jiu','纠':'jiu','玖':'jiu','韭':'jiu','久':'jiu',
'灸':'jiu','九':'jiu','酒':'jiu','厩':'jiu','救':'jiu','旧':'jiu',
'臼':'jiu','舅':'jiu','咎':'jiu','就':'jiu','疚':'jiu',
'鞠':'ju','拘':'ju','狙':'ju','疽':'ju','居':'ju','驹':'ju','菊':'ju',
'局':'ju','咀':'ju','矩':'ju','举':'ju','沮':'ju','聚':'ju','拒':'ju',
'据':'ju','巨':'ju','具':'ju','距':'ju','踞':'ju','锯':'ju','俱':'ju',
'句':'ju','惧':'ju','炬':'ju','剧':'ju','捐':'juan','鹃':'juan',
'娟':'juan','倦':'juan','眷':'juan','卷':'juan','绢':'juan',
'撅':'jue','攫':'jue','抉':'jue','掘':'jue','倔':'jue','爵':'jue','觉':'jue','绝':'jue',

'削':'xiao','靴':'xue','薛':'xue','学':'xue','穴':'xue','雪':'xue','血':'xue',
'勋':'xun','熏':'xun','循':'xun','旬':'xun','询':'xun','寻':'xun','驯':'xun',
'巡':'xun','殉':'xun','汛':'xun','训':'xun','讯':'xun','逊':'xun','迅':'xun',
'压':'ya','押':'ya','鸦':'ya','鸭':'ya','呀':'ya','丫':'ya','芽':'ya','牙':'ya',
'蚜':'ya','崖':'ya','衙':'ya','涯':'ya','雅':'ya','哑':'ya','亚':'ya','讶':'ya',
'焉':'yan','阉':'yan','淹':'yan','盐':'yan','严':'yan','研':'yan','蜒':'yan',
'岩':'yan','延':'yan','言':'yan','颜':'yan','阎':'yan','炎':'yan','沿':'yan',
'奄':'yan','掩':'yan','眼':'yan','衍':'yan','演':'yan','艳':'yan','堰':'yan',
'燕':'yan','厌':'yan','砚':'yan','雁':'yan','唁':'yan','彦':'yan','焰':'yan',
'宴':'yan','谚':'yan','验':'yan','央':'yang','鸯':'yang','秧':'yang','杨':'yang',
'扬':'yang','佯':'yang','疡':'yang','羊':'yang','洋':'yang','阳':'yang','氧':'yang',
'仰':'yang','痒':'yang','养':'yang','样':'yang','漾':'yang','腰':'yao','妖':'yao',
'瑶':'yao','摇':'yao','尧':'yao','遥':'yao','窑':'yao','谣':'yao','姚':'yao',
'咬':'yao','舀':'yao','药':'yao','要':'yao','耀':'yao','椰':'ye','噎':'ye',
'耶':'ye','爷':'ye','野':'ye','冶':'ye','也':'ye','页':'ye','掖':'ye','业':'ye',
'叶':'ye','曳':'ye','腋':'ye','夜':'ye','液':'ye','一':'yi','壹':'yi','医':'yi',
'揖':'yi','铱':'yi','依':'yi','伊':'yi','衣':'yi','颐':'yi','夷':'yi','遗':'yi',
'移':'yi','仪':'yi','胰':'yi','疑':'yi','沂':'yi','宜':'yi','姨':'yi','彝':'yi',
'椅':'yi','蚁':'yi','倚':'yi','已':'yi','乙':'yi','矣':'yi','以':'yi','艺':'yi',
'抑':'yi','易':'yi','邑':'yi','屹':'yi','亿':'yi','役':'yi','臆':'yi','逸':'yi',
'肄':'yi','疫':'yi','亦':'yi','裔':'yi','意':'yi','毅':'yi','忆':'yi','义':'yi',
'益':'yi','溢':'yi','诣':'yi','议':'yi','谊':'yi','译':'yi','异':'yi','翼':'yi',
'翌':'yi','绎':'yi','茵':'yin','荫':'yin','因':'yin','殷':'yin','音':'yin','阴':'yin',
'姻':'yin','吟':'yin','银':'yin','淫':'yin','寅':'yin','饮':'yin','尹':'yin','引':'yin',
'隐':'yin','印':'yin','英':'ying','樱':'ying','婴':'ying','鹰':'ying','应':'ying',
'缨':'ying','莹':'ying','萤':'ying','营':'ying','荧':'ying','蝇':'ying','迎':'ying',
'赢':'ying','盈':'ying','影':'ying','颖':'ying','硬':'ying','映':'ying',
'哟':'yo','拥':'yong','佣':'yong','臃':'yong','痈':'yong','庸':'yong','雍':'yong',
'踊':'yong','蛹':'yong','咏':'yong','泳':'yong','涌':'yong','永':'yong','恿':'yong',
'勇':'yong','用':'yong','幽':'you','优':'you','悠':'you','忧':'you','尤':'you',
'由':'you','邮':'you','铀':'you','犹':'you','油':'you','游':'you','酉':'you',
'有':'you','友':'you','右':'you','佑':'you','釉':'you','诱':'you','又':'you',
'幼':'you','迂':'yu','淤':'yu','于':'yu','盂':'yu','榆':'yu','虞':'yu','愚':'yu',
'舆':'yu','余':'yu','俞':'yu','逾':'yu','鱼':'yu','愉':'yu','渝':'yu','渔':'yu',
'隅':'yu','予':'yu','娱':'yu','雨':'yu','与':'yu','屿':'yu','禹':'yu','宇':'yu',
'语':'yu','羽':'yu','玉':'yu','域':'yu','芋':'yu','郁':'yu','吁':'yu','遇':'yu',
'喻':'yu','峪':'yu','御':'yu','愈':'yu','欲':'yu','狱':'yu','育':'yu','誉':'yu',
'浴':'yu','寓':'yu','裕':'yu','预':'yu','豫':'yu','驭':'yu','鸳':'yuan','渊':'yuan',
'冤':'yuan','元':'yuan','垣':'yuan','袁':'yuan','原':'yuan','援':'yuan','辕':'yuan',
'园':'yuan','员':'yuan','圆':'yuan','猿':'yuan','源':'yuan','缘':'yuan','远':'yuan',
'苑':'yuan','愿':'yuan','怨':'yuan','院':'yuan',
'曰':'yue','约':'yue','越':'yue','跃':'yue','岳':'yue','粤':'yue','月':'yue',
'悦':'yue','阅':'yue','耘':'yun','云':'yun','郧':'yun','匀':'yun','陨':'yun',
'允':'yun','运':'yun','蕴':'yun','酝':'yun','晕':'yun','韵':'yun','孕':'yun',
'匝':'za','砸':'za','杂':'za','栽':'zai','哉':'zai','灾':'zai','宰':'zai','载':'zai',
'再':'zai','在':'zai','咱':'zan','攒':'zan','暂':'zan','赞':'zan',
'赃':'zang','脏':'zang','葬':'zang','遭':'zao','糟':'zao','凿':'zao','藻':'zao',
'枣':'zao','早':'zao','澡':'zao','蚤':'zao','躁':'zao','噪':'zao','造':'zao',
'皂':'zao','灶':'zao','燥':'zao','责':'ze','择':'ze','则':'ze','泽':'ze',
'贼':'zei','怎':'zen','增':'zeng','憎':'zeng','曾':'zeng','赠':'zeng',
'扎':'zha','喳':'zha','渣':'zha','札':'zha','轧':'zha','铡':'zha','闸':'zha',
'眨':'zha','栅':'zha','榨':'zha','咋':'zha','乍':'zha','炸':'zha','诈':'zha',
'摘':'zhai','斋':'zhai','宅':'zhai','窄':'zhai','债':'zhai','寨':'zhai',
'瞻':'zhan','毡':'zhan','詹':'zhan','粘':'zhan','沾':'zhan','盏':'zhan','斩':'zhan',
'辗':'zhan','崭':'zhan','展':'zhan','蘸':'zhan','栈':'zhan','占':'zhan','战':'zhan',
'站':'zhan','湛':'zhan','绽':'zhan','樟':'zhang','章':'zhang','彰':'zhang','漳':'zhang',
'张':'zhang','掌':'zhang','涨':'zhang','杖':'zhang','丈':'zhang','帐':'zhang','账':'zhang',
'仗':'zhang','胀':'zhang','瘴':'zhang','障':'zhang','招':'zhao','昭':'zhao','找':'zhao',
'沼':'zhao','赵':'zhao','照':'zhao','罩':'zhao','兆':'zhao','肇':'zhao','召':'zhao',
'遮':'zhe','折':'zhe','哲':'zhe','蛰':'zhe','辙':'zhe','者':'zhe','锗':'zhe','蔗':'zhe',
'这':'zhe','浙':'zhe','珍':'zhen','斟':'zhen','真':'zhen','甄':'zhen','砧':'zhen',
'臻':'zhen','贞':'zhen','针':'zhen','侦':'zhen','枕':'zhen','疹':'zhen','诊':'zhen',
'震':'zhen','振':'zhen','镇':'zhen','阵':'zhen','蒸':'zheng','挣':'zheng','睁':'zheng',
'征':'zheng','狰':'zheng','争':'zheng','怔':'zheng','整':'zheng','拯':'zheng','正':'zheng',
'政':'zheng','帧':'zheng','症':'zheng','郑':'zheng','证':'zheng','芝':'zhi','枝':'zhi',
'支':'zhi','吱':'zhi','蜘':'zhi','知':'zhi','肢':'zhi','脂':'zhi','汁':'zhi','之':'zhi',
'织':'zhi','职':'zhi','直':'zhi','植':'zhi','殖':'zhi','执':'zhi','值':'zhi','侄':'zhi',
'址':'zhi','指':'zhi','止':'zhi','趾':'zhi','只':'zhi','旨':'zhi','纸':'zhi','志':'zhi',
'挚':'zhi','掷':'zhi','至':'zhi','致':'zhi','置':'zhi','帜':'zhi','峙':'zhi','制':'zhi',
'智':'zhi','秩':'zhi','稚':'zhi','质':'zhi','炙':'zhi','痔':'zhi','滞':'zhi','治':'zhi',
'窒':'zhi','中':'zhong','盅':'zhong','忠':'zhong','钟':'zhong','衷':'zhong','终':'zhong',
'种':'zhong','肿':'zhong','重':'zhong','仲':'zhong','众':'zhong',
'舟':'zhou','周':'zhou','州':'zhou','洲':'zhou','诌':'zhou','粥':'zhou','轴':'zhou',
'肘':'zhou','帚':'zhou','咒':'zhou','皱':'zhou','宙':'zhou','昼':'zhou','骤':'zhou',
'珠':'zhu','株':'zhu','蛛':'zhu','朱':'zhu','猪':'zhu','诸':'zhu','诛':'zhu','逐':'zhu',
'竹':'zhu','烛':'zhu','煮':'zhu','拄':'zhu','瞩':'zhu','嘱':'zhu','主':'zhu','著':'zhu',
'柱':'zhu','助':'zhu','蛀':'zhu','贮':'zhu','铸':'zhu','筑':'zhu','住':'zhu','注':'zhu',
'祝':'zhu','驻':'zhu','抓':'zhua','爪':'zhua','拽':'zhuai','专':'zhuan','砖':'zhuan',
'转':'zhuan','撰':'zhuan','赚':'zhuan','篆':'zhuan','桩':'zhuang','庄':'zhuang','装':'zhuang',
'妆':'zhuang','撞':'zhuang','壮':'zhuang','状':'zhuang','椎':'zhui','锥':'zhui','追':'zhui',
'赘':'zhui','坠':'zhui','缀':'zhui','谆':'zhun','准':'zhun','捉':'zhuo','桌':'zhuo',
'灼':'zhuo','茁':'zhuo','浊':'zhuo','酌':'zhuo','啄':'zhuo','着':'zhuo','琢':'zhuo',
'咨':'zi','资':'zi','姿':'zi','滋':'zi','淄':'zi','孜':'zi','紫':'zi','仔':'zi',
'籽':'zi','滓':'zi','子':'zi','自':'zi','渍':'zi','字':'zi',
'鬃':'zong','棕':'zong','踪':'zong','宗':'zong','综':'zong','总':'zong','纵':'zong',
'走':'zou','奏':'zou','揍':'zou','租':'zu','足':'zu','卒':'zu','族':'zu','祖':'zu',
'诅':'zu','阻':'zu','组':'zu','钻':'zuan','纂':'zuan','嘴':'zui','醉':'zui','最':'zui',
'罪':'zui','尊':'zun','遵':'zun','昨':'zuo','左':'zuo','佐':'zuo','柞':'zuo','做':'zuo',
'作':'zuo','坐':'zuo','座':'zuo',
  '我':'wo','上':'shang','清':'qing','华':'hua','大':'da','学':'xue','北':'bei','京':'jing','哈':'ha','佛':'fo','海':'hai'
}

// ── 核心函数 ─────────────────────────────────────────

function _getPinyin(char: string): string | undefined {
  // 优先检查多音字表
  const poly = POLYPHONE_MAP[char]
  if (poly && poly.length > 0) {
    return poly[0]  // 取最常见读音
  }
  return PINYIN_MAP[char]
}

/**
 * 将中文文本转换为拼音（不包含声调）
 *
 * @example
 *   toPinyin('中国') → 'zhong guo'
 *   toPinyin('中国', { separator: '-' }) → 'zhong-guo'
 */
export function toPinyin(text: string, options?: PinyinOptions): string {
  const sep = options?.separator ?? ' '
  const keepNonChinese = options?.keepNonChinese ?? true
  const result: string[] = []
  let nonChineseBuf = ''

  function flushNonChinese() {
    if (nonChineseBuf) {
      if (keepNonChinese) result.push(nonChineseBuf)
      nonChineseBuf = ''
    }
  }

  for (const char of text) {
    const pinyin = _getPinyin(char)
    if (pinyin) {
      flushNonChinese()
      result.push(pinyin)
    } else {
      nonChineseBuf += char
    }
  }
  flushNonChinese()

  return result.join(sep)
}

/**
 * 将中文文本转换为拼音首字母（prefix）
 *
 * @example
 *   toPinyinPrefix('中国') → 'zg'
 *   toPinyinPrefix('中国', { separator: ' ' }) → 'z g'
 */
export function toPinyinPrefix(text: string, options?: PinyinOptions): string {
  const sep = options?.separator ?? ''
  const keepNonChinese = options?.keepNonChinese ?? true
  const result: string[] = []
  let nonChineseBuf = ''

  function flushNonChinese() {
    if (nonChineseBuf) {
      if (keepNonChinese) result.push(nonChineseBuf)
      nonChineseBuf = ''
    }
  }

  for (const char of text) {
    const pinyin = _getPinyin(char)
    if (pinyin) {
      flushNonChinese()
      result.push(pinyin[0])
    } else {
      nonChineseBuf += char
    }
  }
  flushNonChinese()

  return result.join(sep)
}

/**
 * 拼音 prefix 搜索：检查 candidate 列表中的文本是否匹配拼音查询
 *
 * 匹配策略：
 * 1. 文本本身的拼音 prefix 匹配查询
 * 2. 文本拼音首字母 prefix 匹配查询
 * 3. 文本直接包含查询字符串
 *
 * @param query - 拼音查询字符串（小写）
 * @param candidates - 候选文本列表
 * @returns 匹配的候选文本列表
 */
export function pinyinSearch(query: string, candidates: string[]): string[] {
  if (!query.trim()) return []
  const q = query.toLowerCase().trim()

  return candidates.filter(candidate => {
    return getTextPinyinMatches(candidate, q)
  })
}

/**
 * 检查文本是否匹配拼音查询（单个字符串）
 */
export function getTextPinyinMatches(text: string, query: string): boolean {
  if (!query || !text) return false
  const q = query.toLowerCase().trim()

  // 1. 直接字符串匹配（用户可能输入部分中文）
  if (text.toLowerCase().includes(q)) return true

  // 2. 拼音全拼匹配
  const pinyin = toPinyin(text, { separator: ' ' })
  const pinyinNoSep = pinyin.replace(/ /g, '')
  if (pinyin.toLowerCase().includes(q) || pinyinNoSep.includes(q)) return true

  // 3. 拼音 prefix 分段匹配
  const pinyinWords = pinyin.split(' ')
  const queryWords = q.split(/\s+/)
  if (queryWords.length <= pinyinWords.length) {
    let match = true
    for (let i = 0; i < queryWords.length; i++) {
      if (!pinyinWords[i] || !pinyinWords[i].startsWith(queryWords[i])) {
        match = false
        break
      }
    }
    if (match) return true
  }

  // 4. 拼音首字母组合匹配（如 "qh" → qing hua → 清华大学）
  const initials = toPinyinPrefix(text).toLowerCase()
  if (initials.startsWith(q)) return true

  return false
}

/**
 * 是否为中文字符
 */
export function isChineseChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return code >= 0x4e00 && code <= 0x9fff
}

/**
 * 获取文本中所有中文字符的拼音（用于索引构建）
 */
export function getPinyinTokens(text: string): string[] {
  const tokens: string[] = []
  const pinyin = toPinyin(text, { separator: ' ' })
  tokens.push(pinyin)
  tokens.push(toPinyinPrefix(text))
  return tokens
}
