"""Cross-format behavior checks authored before the first participant run."""
import copy
import inspect
import io
import json
import xml.etree.ElementTree as ET
from types import MappingProxyType

import networkx as nx
import pytest
from networkx.readwrite.gexf import GEXFWriter
from networkx.readwrite.graphml import GraphMLWriter, GraphMLWriterLxml


FORMATS = ["node_link", "adjacency", "cytoscape", "gml", "graphml", "gexf"]
GRAPH_TYPES = [nx.Graph, nx.DiGraph, nx.MultiGraph, nx.MultiDiGraph]
POLICY = {"graph": ["title"], "node": ["color"], "edge": ["weight", "capacity"]}


def graph(kind=nx.Graph):
    g = kind(title="public-title", secret="GRAPH-PRIVATE")
    g.add_node("a", color="blue", secret="NODE-PRIVATE")
    g.add_node("b", color="红色", secret="NODE-PRIVATE")
    g.add_node("isolate", color="green", secret="NODE-PRIVATE")
    g.add_edge("a", "b", weight=1.5, capacity=3, secret="EDGE-PRIVATE")
    g.add_edge("a", "a", weight=2.5, capacity=4, secret="EDGE-PRIVATE")
    if g.is_multigraph():
        g.add_edge("a", "b", key=1, weight=3.5, capacity=5, secret="EDGE-PRIVATE")
    return g


def export(fmt, g, **kwargs):
    if fmt == "node_link":
        return nx.node_link_data(g, edges="links", **kwargs)
    if fmt in ["adjacency", "cytoscape"]:
        return getattr(nx, fmt + "_data")(g, **kwargs)
    return "\n".join(getattr(nx, "generate_" + fmt)(g, **kwargs))


def restore(fmt, value):
    if fmt == "node_link":
        return nx.node_link_graph(value, edges="links")
    if fmt in ["adjacency", "cytoscape"]:
        return getattr(nx, fmt + "_graph")(value)
    if fmt == "gml":
        return nx.parse_gml(value)
    if fmt == "graphml":
        return nx.parse_graphml(value)
    return nx.read_gexf(io.BytesIO(value.encode()))


def encoded(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def test_public_signatures_keep_the_new_option_keyword_only():
    functions = [getattr(nx, name) for name in ["node_link_data", "adjacency_data", "cytoscape_data",
        "tree_data", "generate_gml", "write_gml", "generate_graphml", "write_graphml",
        "write_graphml_xml", "write_graphml_lxml", "generate_gexf", "write_gexf"]]
    for operation in [*functions, GraphMLWriter, GraphMLWriterLxml, GEXFWriter]:
        parameter = inspect.signature(operation).parameters.get("attribute_filter")
        assert parameter is not None, operation
        assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
        assert parameter.default is None


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize("kind", GRAPH_TYPES)
def test_filtered_attributes_preserve_topology_and_source(fmt, kind):
    g = graph(kind)
    before = copy.deepcopy(g)
    policy = copy.deepcopy(POLICY)
    value = export(fmt, g, attribute_filter=policy)
    text = encoded(value)
    assert "PRIVATE" not in text
    h = restore(fmt, value)
    assert set(h) == set(g)
    assert h.number_of_edges() == g.number_of_edges()
    assert h.is_directed() == g.is_directed()
    assert h.nodes["a"]["color"] == "blue"
    assert h.nodes["b"]["color"] == "红色"
    assert sorted(data["weight"] for _, _, data in h.edges(data=True)) == sorted(
        data["weight"] for _, _, data in g.edges(data=True)
    )
    if fmt != "gexf":
        assert h.graph["title"] == "public-title"
    assert nx.utils.graphs_equal(g, before)
    assert policy == POLICY
    assert "NODE-PRIVATE" in encoded(export(fmt, g))


@pytest.mark.parametrize("fmt", FORMATS)
def test_none_missing_empty_and_generator_allowlists(fmt):
    g = graph(nx.MultiDiGraph)
    original = encoded(export(fmt, g))
    assert encoded(export(fmt, g, attribute_filter=None)) == original
    assert encoded(export(fmt, g, attribute_filter={})) == original
    selective = export(fmt, g, attribute_filter={"node": []})
    assert "NODE-PRIVATE" not in encoded(selective)
    assert "EDGE-PRIVATE" in encoded(selective)
    assert "color" not in encoded(selective)
    h = restore(fmt, export(fmt, g, attribute_filter={"graph": [], "node": [], "edge": []}))
    assert set(h) == set(g)
    assert h.number_of_edges() == g.number_of_edges()
    assert h.is_directed()
    assert all("color" not in attrs and "secret" not in attrs for _, attrs in h.nodes(data=True))
    assert all("weight" not in attrs and "secret" not in attrs for _, _, attrs in h.edges(data=True))
    once = {"node": iter(["color"]), "edge": iter(["weight"]), "graph": None}
    projected = restore(fmt, export(fmt, g, attribute_filter=once))
    assert [projected.nodes[n]["color"] for n in g] == [g.nodes[n]["color"] for n in g]
    assert all("weight" in attrs for _, _, attrs in projected.edges(data=True))


@pytest.mark.parametrize("fmt", FORMATS)
@pytest.mark.parametrize("policy,error", [
    ([], TypeError), ({"unknown": []}, ValueError), ({"node": "color"}, TypeError),
    ({"node": b"color"}, TypeError), ({"edge": [1]}, TypeError), ({"graph": 1}, TypeError),
])
def test_invalid_policy_is_rejected(fmt, policy, error):
    # Require the feature to exist, so an unknown keyword cannot satisfy TypeError checks.
    name = fmt + "_data" if fmt in FORMATS[:3] else "generate_" + fmt
    assert "attribute_filter" in inspect.signature(getattr(nx, name)).parameters
    with pytest.raises(error):
        export(fmt, graph(), attribute_filter=policy)


@pytest.mark.parametrize("fmt", ["gml", "graphml", "gexf"])
def test_excluded_unsupported_values_never_reach_xml_or_gml_conversion(fmt):
    g = graph()
    g.graph["secret"] = object()
    g.nodes["a"]["secret"] = object()
    g["a"]["b"]["secret"] = object()
    value = export(fmt, g, attribute_filter=POLICY)
    h = restore(fmt, value)
    assert h.nodes["a"]["color"] == "blue"
    assert h["a"]["b"]["weight"] == 1.5


@pytest.mark.parametrize("fmt", ["graphml", "gexf"])
def test_default_attribute_declarations_follow_their_domain(fmt):
    g = graph()
    g.graph["node_default"] = {"color": "white", "secret": "DEFAULT-NODE-PRIVATE"}
    g.graph["edge_default"] = {"capacity": 0, "secret": "DEFAULT-EDGE-PRIVATE"}
    value = export(fmt, g, attribute_filter=POLICY)
    assert "PRIVATE" not in value
    h = restore(fmt, value)
    assert h.graph["node_default"].get("color") == "white"
    assert h.graph["edge_default"].get("capacity") == 0
    assert "secret" not in h.graph["node_default"]
    assert "secret" not in h.graph["edge_default"]


@pytest.mark.parametrize("fmt", FORMATS)
def test_readonly_mapping_and_none_scope(fmt):
    policy = MappingProxyType({"node": frozenset(["color"]), "edge": None})
    value = encoded(export(fmt, graph(), attribute_filter=policy))
    assert "NODE-PRIVATE" not in value
    assert "EDGE-PRIVATE" in value


def test_gexf_optional_identity_label_and_visualization_are_filtered_consistently():
    g = graph()
    g.nodes["a"].update(id="NODE-PRIVATE-ID", label="NODE-PRIVATE-LABEL",
        viz={"color": {"r": 1, "g": 2, "b": 3, "a": 1.0}})
    g["a"]["b"].update(id="EDGE-PRIVATE-ID", label="EDGE-PRIVATE-LABEL")
    before = copy.deepcopy(g)
    value = export("gexf", g, attribute_filter=POLICY)
    assert "PRIVATE" not in value
    h = restore("gexf", value)
    assert set(h) == set(g) and h.number_of_edges() == g.number_of_edges()
    assert h.nodes["a"]["label"] == "a"
    assert "viz" not in h.nodes["a"]
    assert nx.utils.graphs_equal(g, before)


@pytest.mark.parametrize("fmt", ["gml", "graphml", "gexf"])
@pytest.mark.parametrize("suffix", ["", ".gz", ".bz2"])
def test_file_writers_and_generators_agree(tmp_path, fmt, suffix):
    g = graph(nx.MultiDiGraph)
    path = tmp_path / ("filtered." + fmt + suffix)
    getattr(nx, "write_" + fmt)(g, path, attribute_filter=POLICY)
    h = getattr(nx, "read_" + fmt)(path)
    expected = restore(fmt, export(fmt, g, attribute_filter=POLICY))
    assert nx.utils.graphs_equal(h, expected)


@pytest.mark.parametrize("backend", ["xml", "lxml"])
def test_graphml_backends_keep_explicit_structural_edge_ids(backend):
    g = graph()
    g["a"]["b"]["external_id"] = "stable-edge"
    target = io.BytesIO()
    writer = getattr(nx, "write_graphml_" + backend)
    writer(g, target, attribute_filter=POLICY, edge_id_from_attribute="external_id")
    xml = target.getvalue().decode()
    assert "PRIVATE" not in xml
    assert 'id="stable-edge"' in xml
    assert 'attr.name="external_id"' not in xml
    assert nx.read_graphml(io.BytesIO(target.getvalue())).nodes["a"]["color"] == "blue"


@pytest.mark.parametrize("kind", ["graphml", "gexf", "lxml"])
def test_writer_instances_apply_policy_to_later_graphs(kind):
    g = graph()
    if kind == "graphml":
        writer = GraphMLWriter(attribute_filter=POLICY)
        writer.add_graph_element(g)
        writer.add_graph_element(graph(nx.DiGraph))
        value = str(writer)
    elif kind == "gexf":
        writer = GEXFWriter(attribute_filter=POLICY)
        writer.add_graph(g)
        writer.add_graph(graph(nx.DiGraph))
        value = str(writer)
    else:
        target = io.BytesIO()
        writer = GraphMLWriterLxml(target, attribute_filter=POLICY)
        writer.add_graph_element(g)
        writer.add_graph_element(graph(nx.DiGraph))
        writer.dump()
        value = target.getvalue().decode()
    assert "PRIVATE" not in value
    assert len([e for e in ET.fromstring(value).iter() if e.tag.split('}')[-1] == 'graph']) == 2
    assert "blue" in value


@pytest.mark.parametrize("fmt", FORMATS)
def test_graph_views_are_filtered_without_mutation(fmt):
    original = graph(nx.DiGraph)
    before = copy.deepcopy(original)
    view = nx.subgraph_view(original, filter_node=lambda node: node != "isolate")
    h = restore(fmt, export(fmt, view, attribute_filter=POLICY))
    assert set(h) == {"a", "b"}
    assert h.number_of_edges() == 2
    assert nx.utils.graphs_equal(original, before)


def test_custom_json_structural_names_survive_empty_policy():
    g = graph(nx.MultiDiGraph)
    policy = {"graph": [], "node": [], "edge": []}
    data = nx.node_link_data(g, source="from", target="to", name="identity", key="edgekey",
        edges="arcs", nodes="vertices", attribute_filter=policy)
    h = nx.node_link_graph(data, source="from", target="to", name="identity", key="edgekey",
        edges="arcs", nodes="vertices")
    assert set(h) == set(g) and h.number_of_edges() == g.number_of_edges()
    attrs = {"id": "identity", "key": "edgekey"}
    data = nx.adjacency_data(g, attrs=attrs, attribute_filter=policy)
    h = nx.adjacency_graph(data, attrs=attrs)
    assert set(h) == set(g) and h.number_of_edges() == g.number_of_edges()
    data = nx.cytoscape_data(g, name="display", ident="identity", attribute_filter=policy)
    h = nx.cytoscape_graph(data, name="display", ident="identity")
    assert set(h) == set(g) and h.number_of_edges() == g.number_of_edges()
    assert "PRIVATE" not in encoded(data)


def test_tree_projection_preserves_children_and_custom_structure():
    g = nx.DiGraph()
    g.add_edges_from([("root", "left"), ("root", "right"), ("left", "leaf")])
    nx.set_node_attributes(g, {node: {"color": "blue", "secret": "NODE-PRIVATE"} for node in g})
    before = copy.deepcopy(g)
    data = nx.tree_data(g, "root", ident="identity", children="branches", attribute_filter=POLICY)
    assert "PRIVATE" not in encoded(data)
    h = nx.tree_graph(data, ident="identity", children="branches")
    assert set(h.edges) == set(g.edges)
    assert all(attrs["color"] == "blue" for _, attrs in h.nodes(data=True))
    empty = nx.tree_data(g, "root", attribute_filter={"node": []})
    assert "color" not in encoded(empty) and "secret" not in encoded(empty)
    assert nx.utils.graphs_equal(g, before)
