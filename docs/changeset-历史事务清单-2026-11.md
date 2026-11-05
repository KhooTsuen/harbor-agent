# changeset 历史事务清单（指向当前源码的那些）

> 生成时间：2026-11-06 · 扫描范围：`E:\Harbor-Dev\dist-portable\Harbor\data\changesets`
>
> **这是一份只读盘点快照，不是规范、不是待办清单。** 数据会变，重跑 `tmp/gen-cs-inventory.mjs` 即可得到新的一份。
> 生成方式见文末「怎么复现」。

## 这份清单说的是什么

Harbor 的 changeset 在改文件**之前**存一份快照，`changeset:rollback` 按快照把文件写回去。
所以只要一条事务「还带快照」且「快照里的路径现在还存在」，它就是一个能覆盖当前文件的入口。

本清单收的就是这类事务里，**路径落在 `E:\CodexWorkbench\src\` 下**的那些。

- 当前可用条目：**131 条**（committed 114 / open 17）
- 已归档（`data\changesets-archived\`）条目：**1 条**（本次归档的 `cs_mvchkbew_1t4v`）

## 为什么值得看一眼

界面只有一处能触发撤销：`TaskCenter` 的「可撤销的改动」区。它拿的是
`changesetList({ limit: 5 })`（最新 5 条），前端再过滤 `status === 'committed' && fileCount > 0`。
所以：**open 的一律看不见；committed 的也只有在最新 5 条之内才看得见。**
本清单里的条目全部落在这个窗口之外 —— 界面点不到，但 IPC `changeset:rollback` 接受任意 id。

另：`changeset.rollback()` 不校验 status，也不校验文件在那之后是否又被改过。
这点已单独立项跟踪，本轮**未改内核代码**。

## committed（114 条）

| 日期 | 事务 id | 任务 id | 现存文件数 / 快照数 |
| --- | --- | --- | --- |
| 2026-11-04 | `cs_mw2jmk91_unup` | `task_mw2jmk8y_fwj6` | 3 / 3 |
| 2026-11-04 | `cs_mw2apxqc_prmd` | `task_mw2apxqa_5hl3` | 1 / 1 |
| 2026-11-04 | `cs_mw27zemh_j4rc` | `task_mw27zemf_2fuc` | 1 / 1 |
| 2026-11-03 | `cs_mw16tpd4_ze08` | `task_mw16tpd2_szhg` | 1 / 1 |
| 2026-11-03 | `cs_mw0y2u8c_u02l` | `task_mw0y2u8a_iwii` | 4 / 4 |
| 2026-11-03 | `cs_mw0vxuwp_l08h` | `task_mw0vxuwl_caj9` | 3 / 3 |
| 2026-11-02 | `cs_mvzq6pxs_y5u7` | `task_mvzq6pxp_umyw` | 15 / 15 |
| 2026-11-02 | `cs_mvz4j8cv_4y7v` | `task_mvz4j8cs_vcgf` | 3 / 3 |
| 2026-11-02 | `cs_mvyzkbxe_n981` | `task_mvyxpmzj_d9rn` | 4 / 4 |
| 2026-11-01 | `cs_mvybtib2_60fn` | `task_mvybtiaz_xlvz` | 1 / 1 |
| 2026-11-01 | `cs_mvyawbz3_et4a` | `task_mvyawbz1_px6b` | 6 / 6 |
| 2026-11-01 | `cs_mvy4t0gs_mqoc` | `task_mvy4t0go_5req` | 2 / 2 |
| 2026-10-30 | `cs_mvvf8856_feoj` | `task_mvvf8853_g8sv` | 10 / 10 |
| 2026-10-30 | `cs_mvve4lw9_xgpl` | `task_mvve4lw7_s06j` | 4 / 4 |
| 2026-10-30 | `cs_mvvd9kn5_kefv` | `task_mvvd9kn2_mqfs` | 19 / 19 |
| 2026-10-22 | `cs_mvjstdnx_bnge` | `task_mvjstdnv_bjs0` | 2 / 2 |
| 2026-10-22 | `cs_mvjrkygq_hr1v` | `task_mvjrkygl_3y5z` | 2 / 2 |
| 2026-10-21 | `cs_mvijlhj6_depu` | `task_mvijlhj3_lqlc` | 4 / 4 |
| 2026-10-21 | `cs_mviiqkp7_kj3y` | `task_mviiqkp4_xtpx` | 1 / 1 |
| 2026-10-21 | `cs_mviib9k9_0mno` | `task_mviib9k5_sfv3` | 1 / 1 |
| 2026-10-21 | `cs_mvigvnci_ttuc` | `task_mvigvnce_ntdk` | 7 / 7 |
| 2026-10-21 | `cs_mvif9je2_2bfe` | `task_mvif9jdz_rb7i` | 11 / 11 |
| 2026-10-21 | `cs_mvievy1z_4svq` | `task_mvievy1x_0cmo` | 2 / 2 |
| 2026-10-21 | `cs_mvici5gc_xxaf` | `task_mvici5ga_ai9g` | 7 / 7 |
| 2026-10-21 | `cs_mvi973xn_vfzk` | `task_mvi973xj_1xu4` | 2 / 2 |
| 2026-10-21 | `cs_mvi42sog_blpn` | `task_mvi42soe_6ui6` | 6 / 6 |
| 2026-10-21 | `cs_mvi1mqyh_8cr4` | `task_mvi1mqy8_91mm` | 1 / 1 |
| 2026-10-20 | `cs_mvha510c_3lcj` | `task_mvha510a_riac` | 5 / 5 |
| 2026-10-20 | `cs_mvh9ezq7_epmg` | `task_mvh9ezq4_qt34` | 11 / 11 |
| 2026-10-20 | `cs_mvh8bbzb_51i5` | `task_mvh8bbz9_4ml2` | 1 / 1 |
| 2026-10-20 | `cs_mvh4gn03_vsfq` | `task_mvh4gn01_sgap` | 2 / 2 |
| 2026-10-20 | `cs_mvh34r9f_n5s5` | `task_mvh34r9d_ojzr` | 3 / 3 |
| 2026-10-20 | `cs_mvh2cqo7_efp6` | `task_mvh2cqo4_m3i5` | 1 / 1 |
| 2026-10-20 | `cs_mvgxs2g2_ti5q` | `task_mvgxs2g0_j6dv` | 1 / 1 |
| 2026-10-20 | `cs_mvgndh5m_x0la` | `task_mvgndh5h_4vrq` | 2 / 2 |
| 2026-10-19 | `cs_mvfp99a3_42t6` | `task_mvfp999z_f3pr` | 17 / 17 |
| 2026-10-19 | `cs_mvfnqh56_semy` | `task_mvfnqh53_8fm2` | 5 / 5 |
| 2026-10-19 | `cs_mvfmia4z_kdvm` | `task_mvfmia4v_rkfj` | 3 / 3 |
| 2026-10-19 | `cs_mvfk95u9_5xvl` | `task_mvfk95u6_bxk0` | 13 / 13 |
| 2026-10-19 | `cs_mvfj41ap_99s5` | `task_mvfj41am_v16n` | 2 / 2 |
| 2026-10-19 | `cs_mvfgf77l_1xap` | `task_mvfgf77j_kj25` | 13 / 13 |
| 2026-10-18 | `cs_mveahlqg_xe6g` | `task_mveahlqd_p85l` | 7 / 7 |
| 2026-10-18 | `cs_mve9rdes_fh0n` | `task_mve9rdep_s323` | 2 / 2 |
| 2026-10-17 | `cs_mvcicewf_u745` | `task_mvcicewc_9xsg` | 1 / 1 |
| 2026-10-17 | `cs_mvcf9wzf_veae` | `task_mvcf9wzc_uova` | 3 / 3 |
| 2026-10-17 | `cs_mvcej3se_a668` | `task_mvcej3sc_3fkw` | 2 / 2 |
| 2026-10-17 | `cs_mvcdg7vc_bhps` | `task_mvcdg7va_ww2d` | 1 / 1 |
| 2026-10-17 | `cs_mvcch8et_zz9q` | `task_mvcch8er_7u8i` | 1 / 1 |
| 2026-10-17 | `cs_mvcbytyd_zlmk` | `task_mvcbyty6_5ej0` | 1 / 1 |
| 2026-10-17 | `cs_mvc9kcg6_iyns` | `task_mvc9kcg4_jqym` | 1 / 1 |
| 2026-10-17 | `cs_mvc88875_hjwj` | `task_mvc88873_lcwm` | 3 / 3 |
| 2026-10-17 | `cs_mvbqocc4_bibj` | `task_mvbqocc1_0sls` | 2 / 2 |
| 2026-10-16 | `cs_mvbhx48v_94d9` | `task_mvbhx48t_hed5` | 1 / 1 |
| 2026-10-16 | `cs_mvbcp5r1_6evm` | `task_mvbcp5qz_e5tx` | 3 / 3 |
| 2026-10-16 | `cs_mvbbnpxn_l3f7` | `task_mvbbnpxl_hygw` | 3 / 3 |
| 2026-10-16 | `cs_mvb7b03q_hg76` | `task_mvb7b03n_3ktq` | 1 / 1 |
| 2026-10-15 | `cs_mv9uxths_kmtt` | `task_mv9uxthq_92ml` | 5 / 5 |
| 2026-10-15 | `cs_mv9rmd1e_jw5x` | `task_mv9rmd1c_1tnw` | 1 / 1 |
| 2026-10-15 | `cs_mv9mrp6p_n41k` | `task_mv9mrp6n_n1wz` | 2 / 2 |
| 2026-10-15 | `cs_mv9libtm_qvxz` | `task_mv9libtk_jy13` | 2 / 2 |
| 2026-10-14 | `cs_mv8kspil_rfi6` | `task_mv8kspii_gtu4` | 1 / 1 |
| 2026-10-14 | `cs_mv8kco88_l27p` | `task_mv8kco83_9n18` | 1 / 1 |
| 2026-10-14 | `cs_mv8jskqc_iqtl` | `task_mv8jskqa_w1m7` | 2 / 2 |
| 2026-10-14 | `cs_mv8isvip_b6if` | `task_mv8isvim_ud8b` | 3 / 3 |
| 2026-10-14 | `cs_mv8hnn09_d3ti` | `task_mv8hnn01_75wz` | 6 / 6 |
| 2026-10-13 | `cs_mv6txpoc_ubmh` | `task_mv6txpoa_na2q` | 1 / 1 |
| 2026-10-13 | `cs_mv6t4ygx_yks1` | `task_mv6t4ygv_eji0` | 4 / 4 |
| 2026-10-13 | `cs_mv6saz33_plrz` | `task_mv6saz31_daqp` | 6 / 6 |
| 2026-10-13 | `cs_mv6pxovt_c3kw` | `task_mv6pxovr_w65q` | 1 / 1 |
| 2026-10-13 | `cs_mv6k4j5w_0ssh` | `task_mv6k4j5t_j796` | 6 / 6 |
| 2026-10-13 | `cs_mv6j596i_nfqa` | `task_mv6j596f_2o2k` | 5 / 5 |
| 2026-10-13 | `cs_mv6gilt5_8bz1` | `task_mv6gilt3_dcet` | 1 / 1 |
| 2026-10-13 | `cs_mv6ed71u_la0a` | `task_mv6ed71s_z24d` | 7 / 7 |
| 2026-10-12 | `cs_mv5nmim1_lnjw` | `task_mv5nmilz_zi5o` | 2 / 2 |
| 2026-10-12 | `cs_mv5mw2hs_441f` | `task_mv5mw2hr_63ac` | 5 / 5 |
| 2026-10-11 | `cs_mv49tsll_drmk` | `task_mv49tslj_0emu` | 4 / 4 |
| 2026-10-11 | `cs_mv479w39_6l0i` | `task_mv479w37_veme` | 3 / 3 |
| 2026-10-11 | `cs_mv45q8jc_45n3` | `task_mv45q8ja_bohs` | 1 / 1 |
| 2026-10-11 | `cs_mv44w4fi_aic5` | `task_mv44w4fh_fpjz` | 2 / 2 |
| 2026-10-11 | `cs_mv44btmn_so5m` | `task_mv44btml_thof` | 1 / 1 |
| 2026-10-11 | `cs_mv43r5dq_fyzr` | `task_mv43r5do_h9s8` | 2 / 2 |
| 2026-10-11 | `cs_mv41ywrz_q2iq` | `task_mv41ywry_7sgf` | 6 / 6 |
| 2026-10-11 | `cs_mv40y76n_35dw` | `task_mv40y76l_ud60` | 4 / 4 |
| 2026-10-11 | `cs_mv3yvkot_zst0` | `task_mv3yvkos_00g5` | 13 / 13 |
| 2026-10-11 | `cs_mv3d6oat_s4le` | `task_mv3d6oas_kgyf` | 2 / 2 |
| 2026-10-11 | `cs_mv3bwnhu_0whc` | `task_mv3bwnht_ugjf` | 1 / 1 |
| 2026-10-11 | `cs_mv3a1h6b_90nz` | `task_mv3a1h68_sagt` | 2 / 2 |
| 2026-10-10 | `cs_mv2ubve7_jf94` | `task_mv2ubve5_xit3` | 7 / 7 |
| 2026-10-10 | `cs_mv2sje4n_eup9` | `task_mv2sje4k_ifx4` | 2 / 2 |
| 2026-10-10 | `cs_mv2r13ha_95vy` | `task_mv2r13h8_v4qg` | 6 / 6 |
| 2026-10-10 | `cs_mv2nj5n6_cdct` | `task_mv2nj5n5_tzn5` | 3 / 3 |
| 2026-10-09 | `cs_mv1hkqpp_i1k4` | `task_mv1hkqpm_y6cq` | 2 / 2 |
| 2026-10-09 | `cs_mv1g0lg9_vdo6` | `task_mv1g0lg7_dg7n` | 6 / 6 |
| 2026-10-08 | `cs_muzzbysv_aocm` | `task_muzzbyss_45y2` | 1 / 1 |
| 2026-10-08 | `cs_muzxvuim_fxl1` | `task_muzts34g_a92g` | 10 / 10 |
| 2026-10-08 | `cs_muzwjrw9_9di2` | `task_muzwjrw8_3m0q` | 4 / 5 |
| 2026-10-08 | `cs_muzsplv1_t7do` | `task_muzspluz_ec2y` | 7 / 8 |
| 2026-10-08 | `cs_muz3ycq2_nhg0` | `task_muz3ycq0_txrz` | 1 / 1 |
| 2026-10-07 | `cs_muym0kry_eo0m` | `task_muym0krv_j1am` | 2 / 2 |
| 2026-10-07 | `cs_muyl2o7e_9z8h` | `task_muyl2o7c_cpa6` | 5 / 5 |
| 2026-10-07 | `cs_muyiyw3c_q0s2` | `task_muyiyw3b_wp0k` | 9 / 9 |
| 2026-10-07 | `cs_muyi7xpq_beyu` | `task_muyi7xpp_udfq` | 2 / 2 |
| 2026-10-07 | `cs_muy8dy22_isor` | `task_muy8dy21_foz5` | 1 / 1 |
| 2026-10-07 | `cs_muy7eeur_f55q` | `task_muy7eeuq_ok40` | 4 / 4 |
| 2026-10-07 | `cs_muxofixl_ujic` | `task_muxofixj_nqhx` | 1 / 1 |
| 2026-10-07 | `cs_muxmfhka_y5f6` | `task_muxmfhk8_q6vz` | 2 / 2 |
| 2026-10-06 | `cs_mux5osqn_ab8t` | `task_mux5osql_jd2r` | 3 / 3 |
| 2026-10-06 | `cs_mux1fn1q_uudm` | `task_mux1fn1o_37or` | 1 / 1 |
| 2026-10-06 | `cs_mux0ppcx_hvet` | `task_mux0ppcw_5of4` | 1 / 1 |
| 2026-10-06 | `cs_mux0ecqa_5udg` | `task_mux0ecq9_5der` | 5 / 5 |
| 2026-10-06 | `cs_mux044iz_3ofz` | `task_mux044iy_mhea` | 2 / 2 |
| 2026-10-06 | `cs_muwyzigh_0im6` | `task_muwyzigf_3wms` | 3 / 3 |
| 2026-10-06 | `cs_muwvychu_87y4` | `task_muwvychs_285t` | 4 / 4 |
| 2026-10-06 | `cs_muwujpfi_ypws` | `task_muwujpff_cn01` | 1 / 1 |

## open（17 条）

open = 任务没走到「验证通过」就中断了，状态机不会自己收尾。这些连「已提交」都算不上。

| 日期 | 事务 id | 任务 id | 现存文件数 / 快照数 |
| --- | --- | --- | --- |
| 2026-11-03 | `cs_mw0z5bpo_ywfk` | `task_mw0z5bpl_ub0a` | 2 / 2 |
| 2026-10-31 | `cs_mvwsmi98_xsza` | `task_mvwsmi96_daf3` | 1 / 1 |
| 2026-10-21 | `cs_mvikygi4_eumy` | `task_mvikyghz_52kv` | 2 / 2 |
| 2026-10-21 | `cs_mvi7jxvj_0t42` | `task_mvi7jxve_bel9` | 12 / 12 |
| 2026-10-21 | `cs_mvi2sp8a_pu0x` | `task_mvi2sp83_4ozv` | 8 / 8 |
| 2026-10-18 | `cs_mve8vq52_95nd` | `task_mve8vq4z_5k01` | 3 / 3 |
| 2026-10-18 | `cs_mve6sfyw_89kf` | `task_mve6sfys_6mht` | 5 / 5 |
| 2026-10-17 | `cs_mvczf48j_velv` | `task_mvczf48e_eji4` | 2 / 2 |
| 2026-10-17 | `cs_mvckhkzz_mmqx` | `task_mvckhkzx_ak47` | 12 / 12 |
| 2026-10-16 | `cs_mvb7ijx1_ox3l` | `task_mvb7ijwz_0li8` | 1 / 1 |
| 2026-10-14 | `cs_mv8o9t1v_epdg` | `task_mv8o9t1t_7qbp` | 5 / 5 |
| 2026-10-12 | `cs_mv5s72y8_a5kc` | `task_mv5s72y5_bwf1` | 4 / 4 |
| 2026-10-10 | `cs_mv2vp5cp_vnpv` | `task_mv2vp5cn_m9t3` | 2 / 2 |
| 2026-10-09 | `cs_mv1ewj94_asz8` | `task_mv1ewj91_9xbo` | 3 / 3 |
| 2026-10-08 | `cs_muz39urn_09l9` | `task_muz39url_n8i4` | 1 / 1 |
| 2026-10-07 | `cs_muyjwtf5_md92` | `task_muyjwtf2_xvlv` | 4 / 4 |
| 2026-10-06 | `cs_muwqeuu4_a4yc` | `task_muwqeusq_pssg` | 5 / 5 |

## 已归档

| 日期 | 事务 id | 原状态 | 处理 |
| --- | --- | --- | --- |
| 2026-10-17 | `cs_mvchkbew_1t4v` | open | 2026-11-06 移入 `data\changesets-archived\`，快照与 meta 原样保留 |

## 怎么复现

当时的生成脚本是 `tmp/gen-cs-inventory.mjs`（只读：不写 changeset、不碰源码文件）。

⚠️ `tmp/` 有卫生检查，这类一次性脚本**随时可能已被清掉**。脚本不在了就按判据自己扫一遍：

1. 遍历 `data\changesets\` 下 `cs_` 开头的目录，读每个 `meta.json`；
2. 留下 `status` 为 `committed` 或 `open` 的；
3. 在它的 `files[]` 里挑出 `existed === true && snapshot === true && snap` 非空、
   且 `path` 落在 `E:\CodexWorkbench\src\`、同时**磁盘上该文件现在仍存在**的条目；
4. 按 `startedAt` 倒序排。

## 这份清单没做的事

- 没有移动、合并或删除任何事务 —— 除已归档的那一条。
- 没有判断每条快照「该不该恢复」—— 那是逐个任务的事，不是批量能判的。
- 没有覆盖 `data\changesets` 之外的数据根（各快照备份目录里另有一份历史副本，未纳入本清单）。