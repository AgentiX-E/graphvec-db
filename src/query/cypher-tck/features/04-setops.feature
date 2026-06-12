@tck @setops
Feature: UNION — Set Operations

  Scenario Outline: UNION / INTERSECT / SUBTRACT
    Given a graph with the following nodes:
      | _label   | name     |
      | Person   | Alice    |
      | Person   | Bob      |
      | Person   | Charlie  |
      | Employee | Alice    |
      | Employee | Bob      |
      | Employee | Grace    |
    When executing query:
      """
      <query>
      """
    Then the result should have <expectedCount> rows

    Examples:
      | query                                                              | expectedCount |
      | MATCH (n:Person) RETURN n.name UNION MATCH (m:Employee) RETURN m.name | 6        |
      | MATCH (n:Person) RETURN n.name INTERSECT MATCH (m:Employee) RETURN m.name | 0     |
      | MATCH (n:Person) RETURN n.name SUBTRACT MATCH (m:Employee) RETURN m.name | 3      |
